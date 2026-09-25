import z from "zod"
import fs from "fs"
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

  /** La directory di progetto per un programma: `<base>/bugbounty/programs/<p>/`. */
  export function directory(base: string, program: string): string {
    return path.join(base, "bugbounty", "programs", program)
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
    if (!fs.existsSync(p)) throw new Unreadable(`nessun state.json in ${dir}`)

    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"))
    } catch (e) {
      throw new Unreadable(`JSON non valido in ${p}`, e)
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
    return parsed.data
  }

  /** true se lo stato esiste ed è leggibile (non lancia). */
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
    fs.renameSync(tmp, p)
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
    return Database.use((db) =>
      db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.directory, dir))
        .all()
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

    const counts: Info["findings"] = { total: vulns.length, new: 0, approved: 0, duplicate: 0, other: 0 }
    for (const v of vulns) {
      if (v.status === "new") counts.new++
      else if (v.status === "approved") counts.approved++
      else if (v.status === "duplicate") counts.duplicate++
      else counts.other++
    }

    return { targets: [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host)), findings: counts }
  }

  /**
   * Ricava l'host da un asset dichiarato. Accetta URL (con o senza schema),
   * host:port, e ripiega sull'asset intero quando non riconosce la forma —
   * scelta deliberata: perdere un target è peggio che averne uno non
   * normalizzato.
   */
  export function hostOf(asset: string): string {
    const trimmed = asset.trim()
    if (trimmed.length === 0) return trimmed

    // URL con schema: https://host/path → host
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(trimmed)
    if (withScheme?.[1]) return withScheme[1].toLowerCase()

    // "host:port" o "host/path" — niente schema
    const bare = /^([a-z0-9*_.-]+(?::\d+)?)(?:[/?#].*)?$/i.exec(trimmed)
    if (bare?.[1]) return bare[1].toLowerCase()

    // ARN, path assoluto, o qualunque cosa non riconosciuta: si tiene com'è.
    return trimmed
  }

  /**
   * Legge lo stato e ne rinfresca la parte derivata, scrivendo il risultato.
   * È il "pull" del design: i fatti si ri-derivano a ogni lettura, così uno
   * stato che pecca per difetto si riallinea da solo. Se lo stato non esiste,
   * restituisce quello derivato senza crearlo (il chiamante decide).
   */
  export function refresh(dir: string, program?: string): Info {
    const derived = derive(dir)
    const now = new Date().toISOString()

    const base = (() => {
      try {
        return read(dir)
      } catch {
        return create({ directory: dir, program: program ?? path.basename(dir) })
      }
    })()

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
    if (info.findings.total !== derived.findings.total)
      out.push(`vulnerabilità: stato dichiara ${info.findings.total}, evidenza ne mostra ${derived.findings.total}`)
    return out
  }

  /**
   * Un progetto di hunting è una directory che contiene uno `state.json` bounty
   * OPPURE che sta sotto `bugbounty/programs/`. Il secondo caso conta perché
   * `bb hunt` può aprire la sessione su un progetto appena creato e non ancora
   * scritto: se il riconoscimento dipendesse dall'esistenza del file, il gate
   * non scatterebbe proprio quando serve di più.
   */
  export function isHuntingDir(dir: string): boolean {
    if (path.basename(dir) === "programs" ) return false
    const normalized = path.resolve(dir)
    if (normalized.split(path.sep).join("/").includes("/bugbounty/programs/")) return true
    return fs.existsSync(file(normalized))
  }

  /**
   * Flag per-sessione: "lo stato di questo progetto è stato caricato".
   * Vive in `Instance.state` — quindi si azzera al riavvio, che è corretto:
   * una sessione nuova deve rileggere lo stato.
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
   * Carica lo stato (derivando i fatti) e segna la sessione come "stato letto".
   * È il punto in cui il gate di `todowrite` si sblocca.
   */
  export function load(sessionID: string, dir: string, program?: string): Info {
    const info = refresh(dir, program)
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