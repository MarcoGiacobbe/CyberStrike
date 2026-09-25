// ATTAQUE F — sessions()/derive(): costo O(n) realpath, path spariti, fatti azzerati in silenzio.
import fs from "fs"
import os from "os"
import path from "path"

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "advF-"))
process.env["CYBERSTRIKE_HOME"] = path.join(BASE, "root")
process.env["XDG_DATA_HOME"] = path.join(BASE, "xdg", "data")
process.env["XDG_CACHE_HOME"] = path.join(BASE, "xdg", "cache")
process.env["XDG_CONFIG_HOME"] = path.join(BASE, "xdg", "config")
process.env["XDG_STATE_HOME"] = path.join(BASE, "xdg", "state")
fs.mkdirSync(path.join(BASE, "root", "bugbounty", "programs"), { recursive: true })
const { BountyState } = await import("./src/session/bounty-state")
const { Instance } = await import("./src/project/instance")
const { Database } = await import("./src/storage/db")
const { ProjectTable } = await import("./src/project/project.sql")
const { SessionTable } = await import("./src/session/session.sql")
const { CoverageNoteTable } = await import("./src/session/session.sql")
const PROG = BountyState.programsDir()
const now = Date.now()
function rec(caso: string, input: string, output: string) {
  console.log(`[${caso}]\n  input : ${input}\n  output: ${output}`)
}

const PID = "advproj"
Database.use((db) =>
  db
    .insert(ProjectTable)
    .values({ id: PID, worktree: BASE, vcs: null, name: "adv", sandboxes: [], time_created: now, time_updated: now })
    .onConflictDoNothing()
    .run(),
)

function insertSessions(rows: { id: string; directory: string }[]) {
  Database.use((db) => {
    const stmt = db.insert(SessionTable)
    for (const r of rows)
      stmt
        .values({ id: r.id, slug: r.id, version: "0.0.0", project_id: PID, directory: r.directory, title: r.id, time_created: now, time_updated: now })
        .run()
  })
}

// ---- F1: N sessioni su directory DISTINTE, tutte ESISTENTI ----
{
  const rows = Array.from({ length: 500 }, (_, i) => {
    const d = path.join(PROG, "f1", `s${i}`)
    fs.mkdirSync(d, { recursive: true })
    return { id: `ses_f1_${i}`, directory: d }
  })
  insertSessions(rows)
  const orig = fs.realpathSync
  let calls = 0
  let errs = 0
  ;(fs as any).realpathSync = (...a: any[]) => {
    calls++
    try {
      return (orig as any)(...a)
    } catch (e) {
      errs++
      throw e
    }
  }
  const t0 = performance.now()
  const d = BountyState.derive(PROG)
  const dt = performance.now() - t0
  ;(fs as any).realpathSync = orig
  rec(
    "F1 derive() con 500 sessioni su directory distinte (esistenti)",
    "500 righe in session, tutte directory esistenti",
    `durata=${dt.toFixed(1)}ms; realpathSync chiamate=${calls} (1 per OGNI riga della tabella + 1 per il target); fallite=${errs}`,
  )
}

// ---- F1b: 5000 sessioni su path INESISTENTI (progetto cancellato) ----
{
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `ses_f1b_${i}`, directory: path.join(PROG, "f1b-nonesiste", `x${i}`) }))
  insertSessions(rows)
  const orig = fs.realpathSync
  let calls = 0
  let errs = 0
  ;(fs as any).realpathSync = (...a: any[]) => {
    calls++
    try {
      return (orig as any)(...a)
    } catch (e) {
      errs++
      throw e
    }
  }
  const t0 = performance.now()
  BountyState.derive(PROG)
  const dt = performance.now() - t0
  ;(fs as any).realpathSync = orig
  rec(
    "F1b derive() con 5500 sessioni totali di cui 5000 su path spartiti",
    "path inesistenti: realpath lancia sempre -> fallback resolve",
    `durata=${dt.toFixed(1)}ms; realpathSync chiamate=${calls}; di cui FALLITE=${errs} (ogni fallimento = eccezione JS su ogni riga)`,
  )
  // quante righe totali ha la tabella? (il filtro scansiona OGNI riga di session, non solo del progetto)
  const n = Database.use((db) => db.select({ id: SessionTable.id }).from(SessionTable).all().length)
  rec("F1c il filtro non usa il DB: legge TUTTE le sessioni", "select id,directory from session (nessuna where)", `righe totali in tabella=${n} -> ${n} chiamate realpath per OGNI derive()`)
}

// ---- F2: path sparito -> fatti azzerati in silenzio, e refresh li scrive come fatto ----
{
  const reale = path.join(PROG, "f2-reale")
  fs.mkdirSync(reale, { recursive: true })
  const link = path.join(PROG, "f2-link")
  fs.symlinkSync(reale, link)
  insertSessions([{ id: "ses_f2", directory: link }])
  Database.use((db) =>
    db
      .insert(CoverageNoteTable)
      .values({ id: "cn_f2", session_id: "ses_f2", asset: "https://f2.example.com/x", class: "idor", scope: "local", note: "testato", time_created: now, time_updated: now })
      .run(),
  )
  const a = BountyState.derive(reale)
  const b = BountyState.derive(link)
  rec("F2a con il link PRESENTE", `sessione.directory=${link} -> ${reale}`, `derive(reale).targets=${a.targets.length} derive(link).targets=${b.targets.length}`)
  fs.rmSync(link)
  const c = BountyState.derive(reale)
  rec(
    "F2b con il link RIMOSSO",
    `${link} non esiste piu'; il progetto si legge dalla dir REALE`,
    `derive(reale).targets=${c.targets.length} ${c.targets.length === 0 ? "<-- I FATTI SPARISCONO IN SILENZIO (nessun errore)" : ""}`,
  )
  fs.writeFileSync(
    path.join(reale, "state.json"),
    JSON.stringify({ ...BountyState.create({ directory: reale, program: "f2-reale" }), phase: "testing", targets: [{ host: "f2.example.com", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z", sessions: ["ses_f2"] }] }),
  )
  const r = BountyState.refresh(reale, "f2-reale")
  rec(
    "F2c refresh(reale) dopo la sparizione del link",
    "lo stato su disco dichiara 1 target con prova",
    `targets scritti=${r.targets.length}; divergences=${JSON.stringify(BountyState.divergences(r, BountyState.derive(reale)))} (stato e derivato sono entrambi vuoti -> NESSUNA divergenza: 'nessun target' presentato come fatto)`,
  )
}

// ---- F3: path che canonicalizza alla STESSA dir di un altro progetto -> fatti incrociati ----
{
  const p = path.join(PROG, "f3-a")
  fs.mkdirSync(p, { recursive: true })
  const altro = path.join(PROG, "f3-b")
  fs.mkdirSync(altro, { recursive: true })
  const link = path.join(p, "alias-di-b") // path annidato che canonicalizza a f3-b
  fs.symlinkSync(altro, link)
  insertSessions([{ id: "ses_f3", directory: link }])
  Database.use((db) =>
    db.insert(CoverageNoteTable).values({ id: "cn_f3", session_id: "ses_f3", asset: "https://f3.example.com/x", class: "idor", scope: "local", note: "t", time_created: now, time_updated: now }).run(),
  )
  rec(
    "F3 due directory DIVERSE che canonicalizzano uguali",
    `sessione.directory=${link} (canonical=${BountyState.canonical(link)}); progetto dichiarato=${p}`,
    `derive(${p}).targets=${BountyState.derive(p).targets.length} (il progetto f3-a INCASSA i fatti registrati sotto f3-a/alias-di-b, che e' f3-b); derive(${altro}).targets=${BountyState.derive(altro).targets.length}`,
  )
}

console.log(`\nBASE=${BASE}\nPROG=${PROG}`)