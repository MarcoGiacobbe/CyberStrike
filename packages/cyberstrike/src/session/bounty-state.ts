import z from "zod"
import fs from "fs"
import os from "os"
import path from "path"
import { Database, and, desc, eq, inArray } from "../storage/db"
import { Identifier } from "../id/id"
import { SessionTable, VulnerabilityTable, CoverageNoteTable } from "./session.sql"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

// Project hunting state — fatti dimostrabili vs narrazione.
//
// Design (wayfinder/bb-autonomous-flow/tickets/stato-progetto.md):
//   - Lo stato NON è un file che l'agente legge: è un vincolo che il sistema
//     impone. `state.json` esiste per il caricamento DETERMINISTICO (bb hunt lo
//     legge senza toccare il DB) e per l'ispezione umana.
//   - I FATTI (target toccati, vulnerabilità) vivono nel DB. `state.json` non
//     li duplica: tiene il RIASSUNTO derivato dall'ultima lettura, con
//     timestamp di derivazione. Se il derivato non combacia col DB, vince il DB.
//   - Solo affermazioni che un comando sa dimostrare. La narrazione va in
//     `notes/`, mai letta come stato.
//
// Chiave del progetto = `session.directory`, NON `project_id`: una directory
// non-git mappa sempre sul progetto "global", quindi project_id non identifica
// il programma (verificato in src/project/project.ts:187).

const log = Log.create({ service: "bounty-state" })

export namespace BountyState {
  /**
   * Schema versionato. Un lettore che incontra una versione sconosciuta dichiara
   * lo stato INVALIDO e blocca — non reinterpreta. Uno stato invalido non si
   * aggiusta a mano: si rigenera.
   */
  export const VERSION = 1

  export const Phase = z.enum([
    "idle", // progetto creato, nessun lavoro iniziato
    "recon", // mappatura della superficie
    "testing", // verifica attiva delle classi
    "reporting", // scrittura/triage delle segnalazioni
    "paused", // fermato su richiesta
  ])
  export type Phase = z.infer<typeof Phase>

  /** Un host toccato, con la prova che lo dimostra. */
  export const Target = z.object({
    /** host (o host:port per il network) — la granularità dello scope */
    host: z.string(),
    firstSeen: z.string(),
    lastSeen: z.string(),
    /** sessioni che hanno toccato questo host (prova) */
    sessions: z.string().array(),
  })
  export type Target = z.infer<typeof Target>

  const Counts = z.object({
    total: z.number().int().min(0),
    new: z.number().int().min(0),
    approved: z.number().int().min(0),
    duplicate: z.number().int().min(0),
    other: z.number().int().min(0),
  })

  export const Info = z
    .object({
      version: z.literal(VERSION),
      /** identifica il programma: la directory di lavoro, non il nome */
      directory: z.string(),
      /** nome del programma (per leggibilità umana) */
      program: z.string(),
      phase: Phase,
      /** ISO — quando la fase è stata impostata (push dai comandi) */
      phaseUpdatedAt: z.string(),
      /** ISO — quando lo stato è stato scritto l'ultima volta */
      updatedAt: z.string(),

      // --- derivato dall'evidenza (pull) — mai scritto a mano ---
      /** ISO — quando è stata fatta l'ultima derivazione dal DB */
      derivedAt: z.string().nullable(),
      /** host toccati, derivati dalle sessioni del progetto */
      targets: z.array(Target),
      /** conteggio vulnerabilità per stato, derivato dal DB */
      findings: Counts,

      /** SCOPO dichiarato della sessione corrente (opzionale, umano) */
      objective: z.string().optional(),
    })
    .meta({ ref: "BountyState" })
  export type Info = z.infer<typeof Info>

  /** Stato invalido: schema rotto o versione sconosciuta. Blocca, non indovina. */
  export class Unreadable extends Error {
    readonly reason: string
    constructor(reason: string, cause?: unknown) {
      super(`stato del progetto illeggibile: ${reason}`, { cause })
      this.reason = reason
    }
  }

  /**
   * Radice dei dati bug bounty: `~/.cyberstrike/` (o `$CYBERSTRIKE_HOME`).
   *
   * Sovrascrivibile da ambiente per due motivi: i test devono poter usare una
   * base temporanea (altrimenti scriverebbero nella home dell'utente), e il
   * riconoscimento del progetto deve ancorarsi alla STESSA base che il CLI usa
   * per creare i programmi — se le due divergessero, `bb hunt` creerebbe una
   * sessione in una directory che il gate non riconosce.
   */
  export function root(): string {
    // `path.resolve` sul valore d'ambiente: uno spelling non canonico (`..`,
    // slash doppio, slash finale) faceva divergere la base dai path reali, e il
    // progetto non veniva piu' riconosciuto — gate e perimetro spenti.
    return path.resolve(process.env["CYBERSTRIKE_HOME"] ?? path.join(os.homedir(), ".cyberstrike"))
  }

  /** La directory di progetto per un programma: `<root>/bugbounty/programs/<p>/`. */
  export function directory(base: string, program: string): string {
    return path.join(base, "bugbounty", "programs", program)
  }

  /** `<root>/bugbounty/programs/` — dove vivono TUTTI i progetti di bounty. */
  export function programsDir(): string {
    return path.join(root(), "bugbounty", "programs")
  }

  export function file(dir: string): string {
    return path.join(dir, "state.json")
  }

  /**
   * Legge lo stato da `state.json`. Lancia `Unreadable` se manca, se non è JSON,
   * se non valida lo schema o se la versione è sconosciuta. Non restituisce mai
   * un oggetto "best effort": il chiamante deve poter distinguere "non c'è" da
   * "c'è ed è rotto", perché il primo caso si crea e il secondo si segnala.
   */
  export function read(dir: string): Info {
    const p = file(dir)

    // `lstat`, non `existsSync`: quest'ultimo SEGUE i symlink e torna false per
    // un link la cui destinazione è stata rimossa. Uno `state.json` che esiste
    // (ed è rotto) verrebbe così classificato "assente" e sovrascritto —
    // esattamente ciò che la regola "lo stato invalido blocca" vieta.
    // Una sola `lstat`: due chiamate lascbero una finestra in cui la voce
    // cambia tra il controllo e la lettura.
    const stato = presence(dir)
    if (stato === "absent") throw new Unreadable(`nessun state.json in ${dir}`)

    // FIFO e socket: presenti nell'albero ma non sono file. Leggerli bloccherebbe
    // il processo per sempre, quindi si rifiutano PRIMA di qualsiasi lettura.
    if (stato === "unreadable")
      throw new Unreadable(`state.json presente ma non e' un file leggibile in ${p}`)

    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"))
    } catch (e) {
      // Comprende il symlink che punta a un file rimosso (ENOENT su readFile):
      // "presente ma non leggibile" è diverso da "assente", e va segnalato.
      throw new Unreadable(`state.json presente ma non leggibile in ${p}`, e)
    }

    const version = (raw as { version?: unknown })?.version
    if (version !== VERSION) {
      throw new Unreadable(
        `versione dello stato ${JSON.stringify(version)} non supportata (attesa ${VERSION}); ` +
          `lo stato non si reinterpreta: va rigenerato`,
      )
    }

    const parsed = Info.safeParse(raw)
    if (!parsed.success) throw new Unreadable(`schema non valido: ${parsed.error.message}`)

    // Lo stato appartiene al progetto che DICHIARA, non alla directory da cui lo
    // si legge. Senza questo controllo `mv acme acme-2026` basta a far
    // presentare alla directory nuova il programma vecchio e a far riscrivere il
    // vecchio `state.json` (ricreandolo); un refresh eseguito in A sostituisce
    // poi in silenzio la fase dichiarata dall'utente in B. Si confrontano i path
    // canonici, così uno spelling diverso della STESSA directory (slash finale,
    // symlink) non conta come un progetto diverso.
    if (canonical(parsed.data.directory) !== canonical(dir)) {
      throw new Unreadable(
        `lo state.json dichiara la directory ${parsed.data.directory} ma è stato letto in ${dir}: ` +
          `il progetto è stato spostato o rinominato. Lo stato non si reinterpreta: va rigenerato`,
      )
    }

    return parsed.data
  }

  /**
   * Presenza FISICA di `state.json`, senza interpretarlo: è il discriminante per
   * decidere "lo creo" oppure "lo leggo".
   *
   * `lstat` guarda la voce nell'albero, non la sua destinazione: un symlink c'è
   * anche quando il bersaglio è stato rimosso. Con `existsSync` quel caso
   * tornava "assente", lo stato veniva sovrascritto con `idle` e la fase
   * dichiarata spariva — lo stesso esito che il fix di B1 doveva impedire.
   */
  function presence(dir: string): "absent" | "present" | "unreadable" {
    try {
      const st = fs.lstatSync(file(dir))
      // Una FIFO o un socket NON e' uno stato. `readFileSync` su una named pipe
      // si blocca per SEMPRE in attesa di un writer che non arrivera' mai,
      // congelando il processo (V9/D5). Sono quindi "presenti ma non
      // leggibili": la stessa classe del symlink rotto, non "assenti" (che
      // verrebbero sovrascritte cancellando la fase dichiarata).
      if (st.isFIFO() || st.isSocket()) return "unreadable"
      return "present"
    } catch {
      return "absent"
    }
  }

  /**
   * Path canonico, per confrontare due spelling della STESSA directory.
   *
   * `path.resolve` normalizza `.`, `..` e gli slash finali ma NON i symlink:
   * con `realpath` `<link>/bugbounty/programs/x` e `<reale>/bugbounty/programs/x`
   * coincidono, quindi né il confronto di identità né il riconoscimento del
   * progetto dipendono dallo spelling scelto da chi crea la sessione. Se il path
   * non esiste ancora non c'è nulla da dereferenziare e `resolve` basta.
   */
  export function canonical(p: string): string {
    const resolved = path.resolve(p)
    try {
      return fs.realpathSync(resolved)
    } catch {
      return resolved
    }
  }

  /**
   * true se lo stato esiste ED è leggibile. NON usarlo per decidere "lo creo o
   * lo leggo": confonde "assente" con "invalido" (per lo stato invalido torna
   * false, e chi lo tratta come assente lo sovrascrive). Per quella decisione il
   * discriminante è l'esistenza del file.
   */
  export function exists(dir: string): boolean {
    try {
      read(dir)
      return true
    } catch {
      return false
    }
  }

  /**
   * Scrittura atomica: temporaneo nella stessa directory + rename. Un `state.json`
   * scritto a metà (crash, kill) sarebbe uno stato invalido permanente, e lo
   * stato invalido blocca la sessione: non è un rischio accettabile.
   */
  export function write(info: Info): void {
    const p = file(info.directory)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 })
    try {
      fs.renameSync(tmp, p)
    } catch (e) {
      // Un rename fallito (destinazione che è una directory, permessi, disco
      // pieno) lascerebbe il temporaneo orfano nella directory del progetto:
      // e' una copia dello stato, non deve restare in giro. `force` perche'
      // puo' non essere mai stato creato se la scrittura e' fallita prima.
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // niente: stiamo gia' propagando l'errore originale
      }
      throw e
    }
  }

  /** Crea lo stato iniziale per un progetto appena avviato. */
  export function create(input: { directory: string; program: string; objective?: string }): Info {
    const now = new Date().toISOString()
    return {
      version: VERSION,
      directory: input.directory,
      program: input.program,
      phase: "idle",
      phaseUpdatedAt: now,
      updatedAt: now,
      derivedAt: null,
      targets: [],
      findings: { total: 0, new: 0, approved: 0, duplicate: 0, other: 0 },
      ...(input.objective ? { objective: input.objective } : {}),
    }
  }

  /**
   * Aggiornamento di fase (push): lo chiamano i comandi quando fanno qualcosa.
   * Se lo stato non esiste, lancia — un comando non deve creare stato implicito
   * per un progetto che non è stato avviato.
   */
  export function setPhase(dir: string, phase: Phase): Info {
    const current = read(dir)
    const next: Info = {
      ...current,
      phase,
      phaseUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    write(next)
    return next
  }

  // ==========================================================
  // Derivazione (pull) — i fatti si leggono dall'evidenza
  // ==========================================================

  /** Le sessioni di questo progetto, per `directory`. */
  function sessions(dir: string): string[] {
    // Confronto sul path CANONICO: la stessa directory scritta in modo diverso
    // (slash finale, `.`/`..`, symlink) è lo stesso progetto. Con l'uguaglianza
    // di stringa esatta una spelling diversa faceva AZERARE i fatti derivati
    // (targets e findings a 0) e li presentava come tali, riscrivendoli su disco.
    const target = canonical(dir)
    return Database.use((db) =>
      db
        .select({ id: SessionTable.id, directory: SessionTable.directory })
        .from(SessionTable)
        .all()
        .filter((r) => canonical(r.directory) === target)
        .map((r) => r.id),
    )
  }

  /**
   * Deriva i fatti dimostrabili dal DB: host toccati (dalle `coverage_note`,
   * il cui `asset` è già generico: origin / endpoint / ARN / host:port) e
   * conteggio delle vulnerabilità per stato.
   *
   * Perché `coverage_note` e non `request_observation`: la coverage note è
   * append-only, dichiarata dall'agente DOPO aver testato, con un asset
   * leggibile. L'observation è a livello di forma della richiesta e non dice
   * "quale host ho toccato" in modo leggibile.
   *
   * Il traffico fatto con `curl`/`bash` fuori dal crawler NON entra qui: non
   * lascia evidenza strutturata, quindi non è un fatto dimostrabile. Va in
   * `notes/`. Meglio uno stato che sa meno ma non mente.
   */
  export function derive(dir: string): { targets: Target[]; findings: Info["findings"] } {
    const ids = sessions(dir)

    if (ids.length === 0) {
      return { targets: [], findings: { total: 0, new: 0, approved: 0, duplicate: 0, other: 0 } }
    }

    const notes = Database.use((db) =>
      db
        .select({
          asset: CoverageNoteTable.asset,
          session_id: CoverageNoteTable.session_id,
          created: CoverageNoteTable.time_created,
        })
        .from(CoverageNoteTable)
        .where(inArray(CoverageNoteTable.session_id, ids))
        .all(),
    )

    // Aggregazione per HOST: la granularità a cui è definito lo scope. Un asset
    // tipo "https://app.example.com/api/x" → host "app.example.com". Un asset
    // senza host riconoscibile (ARN, host:port) si tiene com'è: meglio una voce
    // grezza che una persa.
    const byHost = new Map<string, Target>()
    for (const n of notes) {
      const host = hostOf(n.asset)
      // Un asset che non produce un host (vuoto, whitespace, multilinea) non e'
      // un target: scartarlo e' meglio che registrare `host: ""`, che gonfierebbe
      // "Targets touched" con una voce che non dice nulla.
      if (host.length === 0) continue
      const iso = new Date(n.created).toISOString()
      const prev = byHost.get(host)
      if (!prev) {
        byHost.set(host, { host, firstSeen: iso, lastSeen: iso, sessions: [n.session_id] })
        continue
      }
      prev.firstSeen = iso < prev.firstSeen ? iso : prev.firstSeen
      prev.lastSeen = iso > prev.lastSeen ? iso : prev.lastSeen
      if (!prev.sessions.includes(n.session_id)) prev.sessions.push(n.session_id)
    }

    const vulns = Database.use((db) =>
      db
        .select({ status: VulnerabilityTable.status })
        .from(VulnerabilityTable)
        .where(inArray(VulnerabilityTable.session_id, ids))
        .all(),
    )

    const counts: Info["findings"] = { total: 0, new: 0, approved: 0, duplicate: 0, other: 0 }
    for (const v of vulns) {
      if (v.status === "new") counts.new++
      else if (v.status === "approved") counts.approved++
      else if (v.status === "duplicate") counts.duplicate++
      else counts.other++
    }
    // `total` = "real findings": i duplicati sono contati a parte e NON gonfiano
    // il totale, come fa `Vulnerability.confirmed()` per ogni altro lettore
    // (report, context, summary). Un totale che include i duplicati sarebbe una
    // cifra che l'agente legge come fatto e che contraddice il resto del sistema.
    counts.total = counts.new + counts.approved + counts.other

    return { targets: [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host)), findings: counts }
  }

  /**
   * Ricava l'host da un asset dichiarato. Accetta URL (con o senza schema),
   * host:port, e ripiega sull'asset intero quando non riconosce la forma —
   * scelta deliberata: perdere un target è peggio che averne uno non
   * normalizzato.
   */
  export function hostOf(asset: string): string {
    // L'asset e' testo libero scritto dall'agente: va trattato come input non
    // fidato. Un newline non e' un host ma una RIGA in piu' nell'output del
    // tool (`bounty_status` stampa un host per riga): senza questo taglio,
    // un asset tipo "https://x\nFindings: 321 approved" inietta campi falsi
    // che sembrano prodotti dal sistema.
    const firstLine = asset.split(/[\r\n]/)[0] ?? ""
    const trimmed = firstLine.trim()
    if (trimmed.length === 0) return ""

    // URL con schema: https://host/path → host. `hostname` scarta lo userinfo:
    // `https://user:pass@host/x` e' un host chiamato `host`, non
    // `user:pass@host` — che sarebbe una credenziale in chiaro dentro lo stato.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(trimmed)
    if (withScheme?.[1] !== undefined) {
      const rest = withScheme[1]
      const authority = rest.split(/[/?#]/)[0] ?? ""
      const hostport = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority
      return hostport.toLowerCase()
    }

    // "host:port" o "host/path" — niente schema. Esclude spazi e metacaratteri
    // di glob: un asset con spazi non e' un host, e il valore finirebbe in
    // `state.json` come se fosse un fatto verificato.
    const bare = /^([a-z0-9_.-]+(?::\d+)?)(?:[/?#].*)?$/i.exec(trimmed)
    if (bare?.[1]) return bare[1].toLowerCase()

    // Un asset con whitespace interno o vuoto non e' un host: si scarta
    // (ritorno "") invece di propagarlo come target.
    if (/\s/.test(trimmed)) return ""

    // ARN, path assoluto, o qualunque cosa non riconosciuta: si tiene com'è.
    return trimmed
  }

  /**
   * Legge lo stato e ne rinfresca la parte derivata, scrivendo il risultato.
   * È il "pull" del design: i fatti si ri-derivano a ogni lettura, così uno
   * stato che pecca per difetto si riallinea da solo.
   *
   * Distinzione cruciale: "non c'è" e "c'è ed è rotto" NON sono lo stesso caso.
   * Se manca, si crea lo stato iniziale (progetto nuovo). Se è invalido
   * (`Unreadable`), si PROPAGA: rigenerarlo cancellerebbe in silenzio la parte
   * dichiarata (la fase) e presenterebbe uno stato `idle` inventato come fatto.
   * Un cattura-tutto qui vanificherebbe la regola "lo stato invalido blocca".
   */
  export function refresh(dir: string, program?: string): Info {
    const derived = derive(dir)
    const now = new Date().toISOString()

    // Il discriminante e' la PRESENZA FISICA del file (`lstat`), non `exists()`:
    // quest'ultimo inghiotte anche lo stato invalido, e `existsSync` segue i
    // symlink (un link rotto tornerebbe "assente" e verrebbe sovrascritto).
    // "unreadable" (FIFO, socket) NON e' "assente": la voce c'e' nell'albero e
    // rigenerarla distruggerebbe una parte dichiarata, esattamente cio' che
    // questa funzione esiste per impedire. Va propagata come `Unreadable`.
    const stato = presence(dir)
    let base: Info
    if (stato === "unreadable") {
      throw new Unreadable(`state.json presente ma non e' un file leggibile in ${file(dir)}`)
    } else if (stato === "present") {
      base = read(dir) // stato invalido -> Unreadable, si propaga
    } else {
      // Manca del tutto: progetto nuovo, si parte da `idle`.
      base = create({ directory: dir, program: program ?? path.basename(dir) })
    }

    const next: Info = { ...base, derivedAt: now, updatedAt: now, ...derived }
    write(next)
    return next
  }

  /**
   * Confronto fra stato dichiarato e fatti: il design prevede il BLOCCO sul
   * disallineamento. Qui si riporta la divergenza; chi decide se bloccare è il
   * chiamante (bb hunt), che ha il contesto per dirlo all'utente.
   */
  export function divergences(info: Info, derived: { targets: Target[]; findings: Info["findings"] }) {
    const out: string[] = []
    const declared = new Set(info.targets.map((t) => t.host))
    const actual = new Set(derived.targets.map((t) => t.host))
    for (const h of actual) if (!declared.has(h)) out.push(`target toccato ma non nello stato: ${h}`)
    for (const h of declared) if (!actual.has(h)) out.push(`target nello stato ma senza evidenza: ${h}`)

    // La SCOMPOSIZIONE, non solo il totale: con "5 new nel DB presentati come
    // 5 approved" il totale coincideva e il disallineamento passava in silenzio.
    for (const key of ["new", "approved", "duplicate", "other"] as const) {
      if (info.findings[key] !== derived.findings[key])
        out.push(
          `vulnerabilità ${key}: stato dichiara ${info.findings[key]}, evidenza ne mostra ${derived.findings[key]}`,
        )
    }
    if (info.findings.total !== derived.findings.total)
      out.push(`vulnerabilità: stato dichiara ${info.findings.total}, evidenza ne mostra ${derived.findings.total}`)

    // I target hanno una PROVA (le sessioni che li hanno toccati) e un periodo:
    // un `sessions: 40` con id inesistenti, o un `firstSeen` che precede ogni
    // evidenza, è altrettanto falso di un host in più — e altrettanto invisibile
    // se si confrontano solo gli insiemi di host.
    const byHost = new Map(derived.targets.map((t) => [t.host, t]))
    for (const t of info.targets) {
      const d = byHost.get(t.host)
      if (!d) continue
      if (t.sessions.length !== d.sessions.length)
        out.push(
          `target ${t.host}: stato dichiara ${t.sessions.length} sessioni, l'evidenza ne mostra ${d.sessions.length}`,
        )
      if (t.firstSeen !== d.firstSeen)
        out.push(`target ${t.host}: stato dichiara firstSeen ${t.firstSeen}, l'evidenza mostra ${d.firstSeen}`)
    }

    return out
  }

  /**
   * Un progetto di hunting è una directory che contiene uno `state.json` bounty
   * OPPURE che sta ESATTAMENTE sotto `<base bugbounty>/programs/`.
   *
   * Il riconoscimento per path deve essere ANCORATO alla base reale, non a una
   * sottostringa: `"/x/bugbounty/programs/"` compare anche in un repo qualsiasi
   * che abbia una sottodirectory chiamata così, e quel repo verrebbe trattato
   * come progetto di bounty — quindi bloccato, e con uno `state.json` scritto
   * dentro. Si confronta il PREFISSO normalizzato con la base vera.
   *
   * L'esistenza del file non basta da sola a distinguere un progetto di bounty
   * da un `state.json` omonimo in un altro progetto: per questo lo schema è
   * versionato e `read()` distingue "assente" da "illeggibile" (un file che non
   * è uno stato bounty NON viene interpretato come tale).
   */
  export function isHuntingDir(dir: string): boolean {
    // Path CANONICI su entrambi i lati (`realpath`): `path.resolve` non
    // dereferenzia i symlink, quindi un link dentro `programs/` che punta a una
    // directory ESTERNA veniva riconosciuto come progetto e ci si scriveva
    // dentro `state.json` — nella directory vittima. E una base scritta con un
    // symlink/`..`/slash doppio faceva divergere il confronto dal path reale,
    // spegnendo il gate su un progetto vero.
    const normalized = canonical(dir)
    const base = canonical(programsDir())
    // La cartella che CONTIENE i programmi non è un programma.
    if (normalized === base) return false

    // Solo i FIGLI DIRETTI della base sono progetti di bounty, e solo se sono
    // directory. Accettare qualunque profondita' faceva scambiare per progetto
    // una sessione aperta in `<programma>/scans`: riceveva uno stato NUOVO
    // (`program` = basename, `phase` = idle) presentato come fatto, mentre la
    // fase dichiarata nel progetto padre spariva dall'orizzonte.
    const rel = path.relative(base, normalized)
    if (rel !== "" && !path.isAbsolute(rel) && !rel.split(path.sep).includes("..")) {
      if (rel.split(path.sep).length !== 1) return false
      try {
        if (!fs.statSync(normalized).isDirectory()) return false
      } catch {
        return false
      }
      return true
    }

    // Fuori dal layout ufficiale: conta solo uno stato VALIDO. Il solo esistere
    // di un file chiamato `state.json` non basta — una repo qualsiasi che ne ha
    // uno (es. Terraform) armava il gate, e poi `bounty_status` non poteva
    // sbloccarlo (lo schema non era quello bounty): sessione bloccata per
    // sempre da un file estraneo, e con uno `state.json` parassita riscritto
    // dentro. Un progetto di bounty spostato fuori dal layout continua a essere
    // riconosciuto, perche' il suo stato e' valido.
    return exists(normalized)
  }

  /**
   * Flag "lo stato di questo progetto è stato caricato".
   *
   * ATTENZIONE alla granularità: vive in `Instance.state`, la cui chiave è
   * `Instance.directory` (src/project/instance.ts) — quindi è per
   * (sessione, directory), non per sola sessione: la stessa sessione che ha
   * caricato il progetto A risulta "non caricata" in B. E' la granularità
   * corretta per il gate (il blocco riguarda un progetto, non l'agente in
   * astratto), ma non va chiamata "per-sessione" (lo era nei commenti e in un
   * test: corretti, non era vero).
   *
   * Si azzera al riavvio e con `Instance.dispose()`: una sessione nuova deve
   * rileggere lo stato.
   */
  const loadedFlag = Instance.state(() => {
    const set = new Set<string>()
    return set
  })

  /** Segna lo stato come caricato in questa sessione (chiamato da `bounty_status`/`bb hunt`). */
  export function markLoaded(sessionID: string): void {
    loadedFlag().add(sessionID)
  }

  /** true se questa sessione ha già caricato lo stato del progetto. */
  export function loaded(sessionID: string): boolean {
    return loadedFlag().has(sessionID)
  }

  /** Solo per i test: azzera il flag di una sessione. */
  export function unmarkLoaded(sessionID: string): void {
    loadedFlag().delete(sessionID)
  }

  /**
   * Ragioni per cui la sessione è bloccata: lo stato dichiarato contraddice i
   * fatti derivati dall'evidenza (vedi `divergences`). Vive in `Instance.state`
   * come `loadedFlag`, quindi è per-sessione e si azzera al riavvio.
   *
   * Il gate di `todowrite` consulta questo insieme a `loaded`: caricare uno
   * stato che mente non autorizza a pianificare. Un blocco non è un errore
   * transitorio — si sblocca ri-derivando (`bounty_status --refresh true`,
   * che riscrive lo stato dai fatti) e non con un nuovo load a stato fermo.
   */
  const blockedFlag = Instance.state(() => {
    const map = new Map<string, string[]>()
    return map
  })

  /** Blocca la sessione elencando le divergenze rilevate. */
  export function markBlocked(sessionID: string, reasons: string[]): void {
    blockedFlag().set(sessionID, [...reasons])
    // Lo stato caricato non autorizza più: toglierlo evita che un `loaded`
    // residuo da una lettura precedente tenga aperto il gate.
    loadedFlag().delete(sessionID)
  }

  /** Motivi del blocco; array vuoto se la sessione non è bloccata. */
  export function blocked(sessionID: string): string[] {
    return blockedFlag().get(sessionID) ?? []
  }

  /** true se la sessione è bloccata da una divergenza. */
  export function isBlocked(sessionID: string): boolean {
    return blockedFlag().has(sessionID)
  }

  /** Sblocca la sessione (usato da `load()`, che ri-deriva e risolve). */
  export function clearBlocked(sessionID: string): void {
    blockedFlag().delete(sessionID)
  }

  /**
   * Carica lo stato (derivando i fatti) e segna la sessione come "stato letto".
   * È il punto in cui il gate di `todowrite` si sblocca.
   *
   * `markLoaded` sta DOPO `refresh`: se la lettura fallisce (stato invalido) il
   * gate deve RESTARE chiuso. Marcare prima sbloccherebbe la sessione su un
   * caricamento fallito — cioè il contrario della garanzia.
   */
  export function load(sessionID: string, dir: string, program?: string): Info {
    const info = refresh(dir, program)
    // `load` ri-deriva dai fatti e riscrive: qualunque divergenza dichiarata in
    // precedenza è per costruzione risolta, quindi la sessione non resta
    // bloccata. Un blocco che sopravvivesse qui sarebbe un vicolo cieco.
    clearBlocked(sessionID)
    markLoaded(sessionID)
    log.info("bounty state loaded", { directory: dir, program: info.program, targets: info.targets.length })
    return info
  }

  /**
   * Lo stato invalido non si aggiusta a mano: si rigenera da zero, perdendo la
   * sola parte spinta (fase), che è anch'essa ricostruibile. Chiamato da un
   * comando esplicito, mai in automatico durante una lettura.
   */
  export function regenerate(dir: string, program: string): Info {
    const now = new Date().toISOString()
    const fresh: Info = { ...create({ directory: dir, program }), phase: "idle", phaseUpdatedAt: now }
    write(fresh)
    return refresh(dir, program)
  }
}