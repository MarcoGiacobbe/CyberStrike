import type { BountyProgramConfig } from "@cyberstrike-io/hackbrowser/bugbounty"
import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync, chmodSync, renameSync, rmSync, realpathSync, openSync, closeSync, statSync } from "node:fs"
import type { Stats } from "node:fs"
import path from "node:path"

/**
 * I tre file che stanno nella directory di un programma.
 *
 * La domanda che questa parte deve rispondere: che cosa legge un agente appena
 * arriva, e in che ordine? La risposta e' la stessa di un progetto normale:
 * `AGENTS.md` e' l'indice (corto, dice dove trovare tutto), `scope.md` e' lo
 * scope, e la policy integrale resta sul file scritto da `bb sync`.
 *
 * Perche' NON rigenerare qui la policy. `bb sync` gia' scrive
 * `<handle>.policy.md` con il testo integrale; rigenerarlo qui duplicherebbe
 * la fonte e aprirebbe la porta a due copie che divergono. Il compito di
 * questo modulo e' il rimando, non la copia.
 */

/** Un asset e' un URL se ha un nome di dominio, non se "sembra" un indirizzo. */
function looksLikeUrl(asset: string): boolean {
  const a = asset.trim()
  if (!a) return false
  if (a.startsWith("http://") || a.startsWith("https://")) return true
  // Un id numerico (id6472513080) NON e' un dominio: non ha un punto.
  if (/^\d+$/.test(a)) return false
  // serve almeno una lettera prima del punto: `company.thebrowser.arc` sì,
  // ma `1.2.3.4` e' un indirizzo IP, non un sito web da visitare.
  return /[a-z0-9-]+\.[a-z]{2,}/i.test(a)
}

export type TargetClassification = {
  inScope: string[]
  outOfScope: string[]
  /** asset in-scope visitabili via browser */
  urls: string[]
  /**
   * Asset in-scope che NON sono siti: app desktop, estensioni, prodotti.
   * Vanno tenuti separati dagli URL perche' un agente che li legge accanto
   * agli URL puo' tentare di visitarli come se fossero pagine web.
   */
  products: string[]
  /** in-scope non classificabili come URL ne' come prodotto */
  unclassified: string[]
}

export function classifyTargets(config: BountyProgramConfig): TargetClassification {
  const inScope = config.scope?.in ?? []
  const outOfScope = config.scope?.out ?? []
  const urls: string[] = []
  const products: string[] = []
  const unclassified: string[] = []
  for (const raw of inScope) {
    const a = String(raw).trim()
    if (!a) continue
    if (looksLikeUrl(a)) urls.push(a)
    // Una riga con spazi e parole ("Arc on Mac") e' un prodotto, non un host.
    else if (/\s/.test(a)) products.push(a)
    else unclassified.push(a)
  }
  return { inScope, outOfScope, urls, products, unclassified }
}

/**
 * Il path della policy integrale di un programma.
 *
 * `directory` e' la directory DEL PROGRAMMA (`…/bugbounty/programs/<handle>`),
 * non la radice dei programmi: e' li' che `bb sync` scrive la policy e, in
 * sandbox, e' l'unica directory che il perimetro copre.
 *
 * Prima questo path si costruiva da `programsDir` (la radice
 * `…/bugbounty/programs`), producendo `…/bugbounty/programs/<handle>.policy.md`
 * — un file che non esiste e che nessuno scriveva. La firma aveva due
 * significati incompatibili per lo stesso parametro: qui la radice dei
 * programmi, dentro `policyPath` la directory della policy. Con il layout
 * nuovo il riferimento e' la directory del programma, che arriva gia' come
 * `directory`.
 */
function policyPath(config: BountyProgramConfig, directory: string): string {
  return path.join(directory, `${config.name}.policy.md`)
}

function ageDays(config: BountyProgramConfig, now = new Date()): number | null {
  if (!config.lastUpdated) return null
  const t = Date.parse(config.lastUpdated)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

export function renderScopeDoc(config: BountyProgramConfig, now = new Date()): string {
  const c = classifyTargets(config)
  const out: string[] = []
  out.push(`# Scope — ${config.name}`)
  out.push("")
  if (config.description) out.push(`${config.description}`)
  if (config.programUrl) out.push(`Programma: ${config.programUrl}`)
  const age = ageDays(config, now)
  out.push(
    age === null
      ? "Dati mai sincronizzati: lanciare `bb sync " + config.name + "` prima di fidarsi."
      : `Dati aggiornati ${age === 0 ? "oggi" : age === 1 ? "ieri" : `di ${age} giorni`}. Se ti sembrano vecchi, chiedi un \`bb sync\`.`,
  )
  out.push("")

  out.push("## Siti web in scope")
  if (c.urls.length === 0) out.push("- nessuno")
  else for (const u of c.urls) out.push(`- ${u}`)
  out.push("")

  out.push("## Prodotti in scope (non sono siti web)")
  if (c.products.length === 0) out.push("- nessuno")
  else {
    out.push("Non aprire questi come pagine web: sono app o prodotti.")
    for (const p of c.products) out.push(`- ${p}`)
  }
  out.push("")

  if (c.unclassified.length) {
    out.push("## In scope, da chiarire con l'utente")
    for (const u of c.unclassified) {
      out.push(`- ${u} (non e' un sito ne' un prodotto: chiedi prima)`)
    }
    out.push("")
  }

  if (c.outOfScope.length) {
    out.push("## FUORI scope — non toccare")
    for (const o of c.outOfScope) out.push(`- ${o}`)
    out.push("")
  }

  out.push("## Payout")
  const p = config.payouts
  if (p) {
    out.push("| severita' | importo |")
    out.push("| --- | --- |")
    for (const k of ["low", "medium", "high", "critical"] as const) {
      if (p[k] && p[k] !== "n/a") out.push(`| ${k} | ${p[k]} |`)
    }
  } else out.push("- non disponibile")
  out.push("")
  out.push("Questi sono i massimi del programma, non per singolo target.")
  return out.join("\n") + "\n"
}

export function renderAgentsDoc(
  config: BountyProgramConfig,
  directory: string,
  now = new Date(),
): string {
  const policy = policyPath(config, directory)
  // «Presente» vuol dire «ha contenuto», non «esiste». MISURATO
  // (deleg_647f66d0): il sandbox crea un placeholder vuoto con `touch` per
  // avere un mount-point, e `existsSync` su quel file diceva «policy
  // integrale in locale» indicando il nome di un file di ZERO byte. L'agente
  // lo leggeva e riassumeva un contratto che non aveva mai letto — peggio
  // del ramo «non in locale», che almeno gli dice di fare `bb sync`.
  //
  // Il controllo e' `stat`: dimensione > 0. Un file che non esiste e un file
  // vuoto sono lo stesso caso dal punto di vista di chi deve leggerlo.
  let hasPolicy = false
  try {
    hasPolicy = statSync(policy).size > 0
  } catch {
    // assente: resta false
  }
  const out: string[] = []
  out.push(`# ${config.name} — bug bounty`)
  out.push("")
  out.push("Sei dentro la directory di questo programma. Leggi questo file e poi")
  out.push("`scope.md` prima di toccare qualsiasi target.")
  out.push("")
  out.push("## Cosa c'e' qui")
  out.push("")
  out.push("- `scope.md` — cosa e' dentro e cosa no, con i payout.")
  out.push(
    "- `tmp/` — l'unica cartella dove scrivere i file di caccia (PoC, payload,",
  )
  out.push(
    "  script, output). Tutto quello che hai prodotto sta qui dentro: puoi",
  )
  out.push(
    "  cancellare senza perdita. Non scrivere altrove, nemmeno in `/tmp` di sistema.",
  )
  // Il rimando e' RELATIVO (`bcny.policy.md`), mai assoluto.
  //
  // `AGENTS.md` viene generato sull'host ma letto dentro il container, dove
  // la directory del programma e' montata su un path DIVERSO. Un path
  // assoluto qui e' un rimando rotto per costruzione: MISURATO il
  // 2026-10-02, il file diceva
  // `/home/marco/.cyberstrike/bugbounty/programs/bcny/bcny.policy.md` e nel
  // container la policy era in `/work/bugbounty/programs/bcny/…`. L'agente
  // leggeva il rimando, non trovava nulla, e si fermava dicendo «non posso
  // verificarla». Nell run precedente era passato solo perche' aveva
  // IGNORATO il rimando e indovinato il path locale: successo per fortuna,
  // non per configurazione.
  //
  // Un nome relativo funziona nei due posti perche' la policy sta nella
  // stessa directory di `AGENTS.md` in entrambi i casi (stesso layout,
  // radice diversa). Il nome del file basta e resta leggibile.
  out.push(
    hasPolicy
      ? `- La policy integrale del programma: \`${path.basename(policy)}\` (in questa stessa directory).`
      : `- La policy integrale NON e' in locale: lanciare \`bb sync ${config.name}\` e poi rileggere questo file.`,
  )
  out.push("")
  out.push("## Regole che non si negoziano")
  out.push("")
  out.push("- Non uscire da questa directory scrivendo. Lettura ovunque, scrittura qui.")
  out.push("- Fuori scope non si tocca, punto.")
  out.push("- Nessun test di devastazione o di carico: il danno e' irreversibile e nessun bounty lo rimborsa.")
  const max = config.rules?.maxSteps
  if (max) out.push(`- Non oltre ${max} passi su un singolo target.`)
  out.push("- Ogni finding passa da `bounty_status` prima di essere considerato chiuso.")
  out.push("")
  const age = ageDays(config, now)
  if (age === null) out.push("> I dati di questo programma non sono mai stati sincronizzati.")
  else if (age >= 1) out.push(`> Dati aggiornati ${age === 1 ? "ieri" : `di ${age} giorni`}: se il target ti sembra cambiato, chiedi un \`bb sync\`.`)
  return out.join("\n") + "\n"
}

/**
 * Scrive i due file indicizzabili. La policy non viene toccata: esiste gia'.
 * Ritorna i path scritti, cosi' il chiamante puo' stamparli.
 */
export function writeProgramDocs(
  config: BountyProgramConfig,
  directory: string,
  programsDir: string,
  now = new Date(),
): { agents: string; scope: string; policy: string } {
  const agents = path.join(directory, "AGENTS.md")
  const scope = path.join(directory, "scope.md")
  // Difetti trovati dal subagent avversariale (deleg_cb90184f), entrambi
  // MISURATI: `mkdirSync` su un percorso che e' un symlink ha esito 0 e non
  // tocca il link — quindi un `tmp` che punta fuori diventava la directory
  // esterna, scrivibile dall'agente e fuori dal perimetro. E `mkdir` con
  // `recursive` NON corregge i permessi di una directory gia' esistente: una
  // `tmp` lasciata a 0777 restava a 0777. Qui il link si controlla con
  // `lstat` e i permessi si correggono con `chmod` esplicito.
  //
  // Terzo vettore, trovato misurando da soli (non dai subagent): se la
  // DIRECTORY DEL PROGRAMMA e' essa stessa un symlink a una cartella esterna,
  // ogni scrittura "dentro" finisce fuori. MISURATO: `programs/bcny` reso
  // symlink a `/tmp/outdir-...` e `bb hunt bcny --dry-run` ha creato
  // `AGENTS.md`, `scope.md` e `tmp/` DENTRO la cartella esterna, `rc=0`.
  // Chiudere solo i nomi dei file (sopra) non basta: la classe intera si
  // chiude confrontando il percorso REALE con quello atteso.
  assertInsidePrograms(directory, programsDir)
  // Difetto TOCTOU trovato dal quarto subagent (deleg_b41be483) e RIPRODOTTO:
  // fra il controllo e la scrittura il percorso testuale viene RIAPERTO dal
  // kernel, quindi chi puo' sostituire `programs/<prog>` con un symlink fa
  // finire la scrittura fuori, mentre il controllo era passato. Stessa cosa
  // per `programs/` stesso reso symlink (riprodotto senza concorrenza).
  //
  // Un confronto di stringhe non chiude questa classe: serve un ANCORAGGIO
  // sul filesystem. Si apre la directory vera una volta e si scrive SOLO
  // attraverso il suo file descriptor (`/proc/self/fd/N/...`). Il fd pinna
  // l'inode: sostituire il nome dopo l'apertura non sposta piu' la scrittura.
  // MISURATO: con `rename` del percorso a metà sequenza, la scrittura via fd
  // resta nella directory originale.
  return withAnchoredDir(directory, (anchor) => {
    const tmp = `${anchor}/tmp`
    // Il controllo usa l'ANCORA, non il percorso testuale: se la directory e'
    // stata sostituita, il percorso testuale guarderebbe altrove.
    if (lstatSafe(tmp)?.isSymbolicLink()) {
      throw new Error(
        `${path.join(directory, "tmp")} e' un symlink, non una directory: punta fuori dal perimetro. ` +
          `Rimuovilo o sostituiscilo con una directory vera, poi rilancia.`,
      )
    }
    mkdirSync(tmp, { recursive: true, mode: 0o700 })
    // `recursive` non tocca i permessi di una directory gia' esistente: senza
    // questo chmod una tmp preesistente resterebbe con i permessi che aveva.
    chmodSync(tmp, 0o700)
    // I documenti passano dallo stesso ancoraggio: un symlink o hard link
    // piazzato sul nome non riceve il contenuto, perche' `rename` sostituisce
    // il NOME (dentro la directory ancorata) invece di seguirlo.
    for (const [name, body] of [
      ["AGENTS.md", renderAgentsDoc(config, directory, now)],
      ["scope.md", renderScopeDoc(config, now)],
    ] as const) {
      const staging = `${anchor}/.${name}.${process.pid}-${Date.now().toString(36)}.tmp`
      writeFileSync(staging, body, { mode: 0o600, flag: "wx" })
      try {
        renameSync(staging, `${anchor}/${name}`)
      } catch (e) {
        // Se la rename fallisce, il temporaneo va tolto per NOME dentro
        // l'ancora: cercarlo altrove (percorso ormai risolto altrove) e' il
        // secondo difetto riportato — lasciava il .tmp orfano fuori.
        try {
          rmSync(staging, { force: true })
        } catch {}
        throw e
      }
      chmodSync(`${anchor}/${name}`, 0o600)
    }
    return { agents, scope, policy: policyPath(config, directory) }
  })
}

/**
 * Esegue `fn` con un percorso ANCORATO alla directory reale, immune alla
 * sostituzione del nome. `directory` deve esistere.
 */
function withAnchoredDir<T>(directory: string, fn: (anchor: string) => T): T {
  const fd = openSync(directory, "r")
  try {
    // `/proc/self/fd/N` e' il percorso magico che segue il DESCRITTORE, non il
    // nome: se qualcuno rinomina o sostituisce `directory` dopo questa open, le
    // scritture restano sull'inode originale.
    const anchor = `/proc/self/fd/${fd}`
    // Su piattaforme senza `/proc` (macOS) l'ancoraggio non e' disponibile: si
    // ripiega sul percorso normale, che e' la difesa di prima (controllo
    // `realpath` + `rename` sul nome). Detto esplicitamente: la' il TOCTOU
    // resta aperto, e non si finge che sia chiuso.
    if (!existsSync(anchor)) return fn(directory)
    return fn(anchor)
  } finally {
    closeSync(fd)
  }
}

/**
 * Scrive un file DENTRO `dir` senza mai uscire dal perimetro, nemmeno se un
 * link e' stato messo li' prima.
 *
 * Perche' non basta `writeFileSync`: segue i link. MISURATO (deleg_6dc3ac19):
 * con `AGENTS.md` e `scope.md` resi symlink verso una directory esterna,
 * `bb hunt bcny --dry-run` usciva `rc=0` e scriveva 979+757 byte FUORI dal
 * progetto. La prima stesura difendeva solo `tmp/` e lasciava scoperte queste
 * due righe: la toppa era accanto al buco.
 *
 * La garanzia non e' un controllo ma la forma della scrittura:
 *   1. il contenuto va in un file NUOVO nella stessa directory (`flag: "wx"`,
 *      cioe' O_CREAT|O_EXCL: non segue un link e non sovrascrive);
 *   2. `rename` sopra il target SOSTITUISCE la voce di directory. Un symlink
 *      viene rimpiazzato e il file esterno resta intatto; un hard link perde
 *      la sua voce e l'inode esterno NON viene toccato. Nessuno dei due riceve
 *      un byte.
 * Un controllo `lstat` prima della scrittura sarebbe stato aggirabile con una
 * corsa fra il controllo e la scrittura (TOCTOU); questa forma no, perche' non
 * c'e' nessun momento in cui il target viene aperto per scriverci.
 */
/**
 * Verifica che `directory` sia DAVVERO dentro `programsDir`, risolvendo i
 * link. Chiude un'intera CLASSE di vettori in un punto solo: un file-documento
 * reso symlink (gestito da `writeInside`), una `tmp` resa symlink (gestito
 * sotto), e la directory del PROGRAMMA resa symlink — misurato: con
 * `programs/bcny` link a una cartella esterna, `bb hunt bcny --dry-run`
 * creava `AGENTS.md`, `scope.md` e `tmp/` DENTRO la cartella esterna, `rc=0`.
 *
 * `realpathSync` risolve tutti i link del percorso; se il programma non esiste
 * ancora, il confronto cade sul genitore, che e' cio' che si sta per creare.
 * Non e' un controllo TOCTOU-aggirabile come un `lstat`: qui non si decide se
 * scrivere, si stabilisce DOVE — e la scrittura avviene subito dopo sulla base
 * di quel percorso.
 */
function assertInsidePrograms(directory: string, programsDir: string): void {
  // `programs/` STESSA resa symlink (difetto RIPRODOTTO dal quarto subagent,
  // deleg_b41be483, anche SENZA concorrenza): se il link e' su `programs/`,
  // sia `realpath(programsDir)` sia `realpath(directory)` risolvono fuori, e
  // il confronto fra i due — coerenti fra loro — non se ne accorge. Il
  // confronto da solo non basta: la radice del perimetro va controllata.
  const linkRadice = lstatSafe(programsDir)?.isSymbolicLink()
  if (linkRadice) {
    throw new Error(
      `${programsDir} e' un symlink: la radice dei programmi deve essere una ` +
        `directory vera. Un link qui sposta l'intero perimetro altrove, quindi ` +
        `anche il confronto fra percorsi smette di distinguere dentro e fuori.`,
    )
  }
  const realPrograms = realpathDeep(programsDir)
  const realDir = realpathDeep(directory)
  // Difetto RIPRODOTTO dal quinto subagent (deleg_3b5e0b49): confrontare solo
  // il PREFISSO accetta il link a un programma FRATELLO — `programs/bcny` che
  // punta a `programs/other` resta sotto `programs/`, quindi passava, e i
  // documenti di `other` venivano SOVRASCRITTI con i dati di `bcny` (misurato,
  // rc=0). Non e' una fuga dal progetto: e' una violazione del perimetro del
  // PROGRAMMA, che e' il confine vero.
  //
  // Attenzione: `programsDir` NON e' la cartella dei programmi, e' la radice
  // di `bugbounty` (ci vive anche la policy integrale). Quindi l'invariante
  // NON puo' essere "uguale a programs/<nome>": non si sa quale sia
  // `programs/`. Si usano due fatti che valgono comunque:
  //   1. `directory` sta dentro la radice reale — esclude qualsiasi link verso
  //      l'esterno, anche quando la radice stessa e' un link (perche' i due
  //      confronti restano coerenti fra loro, il solo confronto non basta);
  //   2. `directory` e' la figlia diretta di quello che contiene il suo nome —
  //      esclude il link a un fratello, perche' il nome richiesto non coincide
  //      piu' con la directory reale.
  //
  // Difetto RIPRODOTTO dal sesto subagent (deleg_014a4036): il controllo di
  // `programsDir` guardava la RADICE, ma il chiamante production
  // (`bb.ts:861`) passa la radice di `bugbounty` — quindi la cartella dei
  // programmi e' un livello SOTTO, e nessun controllo la guardava. Con
  // `programs/` reso symlink verso `bugbounty/archive/`, la scrittura finiva
  // li'. E il mio test era verde perche' passava come terzo argomento
  // `programs/`, mentre il comando vero passa la radice: la prova non
  // assomigliava alla realta'.
  //
  // La correzione non e' "un solo livello": la profondita' LEGITTIMA varia
  // (`programs/<nome>` sono due livelli sotto la radice, e il chiamante non
  // puo' dirlo alla funzione senza accoppiare i due punti). La regola vera e'
  // piu' forte e non ha bisogno di sapere la profondita': **ogni componente
  // del percorso, fra la radice e il programma, deve essere una directory
  // vera, mai un link.** Cosi' un link a QUALSIASI livello e' rifiutato, e la
  // forma legittima continua a passare qualunque ne sia la profondita'.
  const dentro = path.relative(realPrograms, realDir)
  if (dentro === "" || dentro.startsWith("..") || path.isAbsolute(dentro)) {
    throw new Error(
      `${directory} risolve a ${realDir}, che e' FUORI da ${realPrograms}: il programma ` +
        `non e' una directory vera dentro il progetto, e' un link che punta altrove. ` +
        `Rimuovilo e ricrealo come directory, poi rilancia.`,
    )
  }
  // Ogni componente del cammino deve essere una directory vera. Il cammino va
  // costruito sul percorso TESTUALE (`programsDir`, non `realPrograms`): se
  // usassi il percorso gia' risolto, il symlink sarebbe sparito e il controllo
  // passerebbe sempre — MISURATO, e' esattamente il difetto che questa stessa
  // guardia deve chiudere.
  const componenti = path.relative(path.resolve(programsDir), path.resolve(directory)).split(path.sep)
  let corrente = path.resolve(programsDir)
  for (const componente of componenti) {
    if (componente === "" || componente === ".." || componente === ".") continue
    corrente = path.join(corrente, componente)
    const st = lstatSafe(corrente)
    if (st && st.isSymbolicLink()) {
      throw new Error(
        `${corrente} e' un symlink: il percorso verso ${directory} passa per un link ` +
          `(relativo a ${programsDir}: "${componenti.join("/")}"). Ogni cartella fra ` +
          `la radice e il programma deve essere una directory vera, altrimenti il ` +
          `perimetro e' spostato altrove. Rimuovi il link e ricrealo come directory, ` +
          `poi rilancia.`,
      )
    }
  }
  const atteso = path.join(realpathDeep(path.dirname(path.resolve(directory))), path.basename(path.resolve(directory)))
  if (realDir !== atteso) {
    throw new Error(
      `${directory} risolve a ${realDir} invece che a ${atteso}: il programma e' un link ` +
        `che punta altrove — fuori dal progetto, o a un altro programma. Rimuovilo e ` +
        `ricrealo come directory, poi rilancia.`,
    )
  }
}

/**
 * `realpath` di un percorso che puo' NON esistere ancora: risolve il primo
 * antenato esistente e riattacca la coda. Serve perche' al primo `bb hunt` la
 * directory del programma non c'e' ancora — e `realpathSync` lancerebbe
 * ENOENT proprio sul caso normale, facendo passare per errore un guasto che
 * non c'e'.
 */
function realpathDeep(p: string): string {
  let head = path.resolve(p)
  const tail: string[] = []
  while (!existsSync(head)) {
    const parent = path.dirname(head)
    /* c8 ignore next 3 -- solo se la radice non esiste: impossibile su un
       filesystem montato, ma senza questo il ciclo non termina. */
    if (parent === head) return path.resolve(p)
    tail.unshift(path.basename(head))
    head = parent
  }
  return tail.length ? path.join(realpathSync(head), ...tail) : realpathSync(head)
}

/** `lstat` che non lancia: `undefined` se il percorso non esiste. */
function lstatSafe(p: string): Stats | undefined {
  try {
    return lstatSync(p)
  } catch {
    return undefined
  }
}
