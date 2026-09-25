// ATTAQUE D (presence/lstat: FIFO, directory, chmod 000) + F (sessions/derive: O(n), path spariti).
import fs from "fs"
import os from "os"
import path from "path"

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "advDF-"))
process.env["CYBERSTRIKE_HOME"] = path.join(BASE, "root")
process.env["XDG_DATA_HOME"] = path.join(BASE, "xdg", "data")
process.env["XDG_CACHE_HOME"] = path.join(BASE, "xdg", "cache")
process.env["XDG_CONFIG_HOME"] = path.join(BASE, "xdg", "config")
process.env["XDG_STATE_HOME"] = path.join(BASE, "xdg", "state")
fs.mkdirSync(path.join(BASE, "root", "bugbounty", "programs"), { recursive: true })
const { BountyState } = await import("./src/session/bounty-state")
const { Instance } = await import("./src/project/instance")
const PROG = BountyState.programsDir()
console.log(`uid=${process.getuid?.()} whoami=${Bun.spawnSync(["whoami"]).stdout.toString().trim()}`)

function rec(caso: string, input: string, output: string | Error) {
  console.log(`[${caso}]\n  input : ${input}\n  output: ${output instanceof Error ? `${output.constructor.name}: ${output.message}` : output}`)
}
function t(label: string, fn: () => unknown) {
  try {
    return `${label}: OK -> ${fn()}`
  } catch (e) {
    return `${label}: ${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 140)}`
  }
}

// ---------------- D1: state.json = FIFO ----------------
{
  const dir = path.join(PROG, "d1-fifo")
  fs.mkdirSync(dir, { recursive: true })
  const fifo = path.join(dir, "state.json")
  Bun.spawnSync(["mkfifo", fifo])
  const st = fs.lstatSync(fifo)
  // read() bloccante: eseguo in un SOTTOPROCESSO con timeout per non appendere questo script.
  const child = Bun.spawnSync(
    [
      path.join(os.homedir(), ".local/share/bun-1.3.9/bin/bun"),
      "-e",
      `process.env.CYBERSTRIKE_HOME=${JSON.stringify(process.env["CYBERSTRIKE_HOME"])};
       process.env.XDG_DATA_HOME=${JSON.stringify(process.env["XDG_DATA_HOME"])};
       process.env.XDG_CACHE_HOME=${JSON.stringify(process.env["XDG_CACHE_HOME"])};
       process.env.XDG_CONFIG_HOME=${JSON.stringify(process.env["XDG_CONFIG_HOME"])};
       const {BountyState}=await import(${JSON.stringify(path.resolve("src/session/bounty-state.ts"))});
       const t=Date.now();
       try { BountyState.read(${JSON.stringify(dir)}); console.log("read OK", Date.now()-t) }
       catch(e){ console.log("read THROW", e.constructor.name, String(e.message).slice(0,80), Date.now()-t+"ms") }
       try { BountyState.refresh(${JSON.stringify(dir)}); console.log("refresh OK") }
       catch(e){ console.log("refresh THROW", e.constructor.name, String(e.message).slice(0,80)) }
       process.exit(0);`,
    ],
    { timeout: 5000 },
  )
  rec(
    "D1 state.json e' un FIFO (mkfifo)",
    `fifo=${fifo} lstat isFIFO=${st.isFIFO()} isFile=${st.isFile()}`,
    `presence=lstat OK (quindi 'present'); read()/refresh() eseguiti in un sottoprocesso con timeout 5s -> ` +
      `exitCode=${child.exitCode} (124/-1 = UCCISO PER TIMEOUT, il processo e' rimasto APPESO sulla open del FIFO) ` +
      `stdout=${JSON.stringify(child.stdout.toString().trim())}`,
  )
  rec(
    "D1b conseguenza operativa",
    "bounty_status / bb hunt chiamano refresh() -> read()",
    fs.existsSync(fifo) ? "il FIFO resta; NESSUN timeout nel codice: la sessione dell'agente si blocca a tempo indefinito" : "n/d",
  )
}

// ---------------- D2: state.json e' una DIRECTORY ----------------
{
  const dir = path.join(PROG, "d2-dir")
  fs.mkdirSync(path.join(dir, "state.json"), { recursive: true }) // "state.json" come DIRECTORY
  const st = fs.lstatSync(path.join(dir, "state.json"))
  rec("D2 state.json e' una DIRECTORY", `${dir}/state.json isDirectory=${st.isDirectory()} isFile=${st.isFile()}`, "")
  console.log(
    "  " +
      [
        t("presence file (lstat) = present", () => "present"),
        t("read()", () => BountyState.read(dir).program),
        t("exists()", () => BountyState.exists(dir)),
        t("refresh()", () => BountyState.refresh(dir, "d2").phase),
        t("regenerate()", () => BountyState.regenerate(dir, "d2").phase),
        t("setPhase()", () => BountyState.setPhase(dir, "recon").phase),
      ].join("\n  "),
  )
  rec(
    "D2b residui .tmp nella dir del progetto",
    `ls ${dir}`,
    JSON.stringify(fs.readdirSync(dir)),
  )
}

// ---------------- D3: state.json chmod 000 ----------------
{
  const dir = path.join(PROG, "d3-noperm")
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, "state.json")
  fs.writeFileSync(f, JSON.stringify({ ...BountyState.create({ directory: dir, program: "d3" }), phase: "testing" }))
  const prima = fs.readFileSync(f, "utf8")
  fs.chmodSync(f, 0o000)
  rec(
    "D3 state.json presente ma chmod 000 (uid non-root)",
    `uid=${process.getuid?.()} mode=${(fs.statSync(f).mode & 0o777).toString(8)}`,
    [t("read()", () => BountyState.read(dir).program), t("exists()", () => BountyState.exists(dir)), t("refresh()", () => BountyState.refresh(dir, "d3").phase)].join(" | "),
  )
  fs.chmodSync(f, 0o600)
  rec(
    "D3b lo stato dichiarato e' stato SOVRASCRITTO?",
    `contenuto prima = phase testing`,
    `contenuto dopo = ${JSON.stringify(JSON.parse(fs.readFileSync(f, "utf8")).phase)} (identico? ${prima === fs.readFileSync(f, "utf8")})`,
  )
}

// ---------------- D4: state.json = symlink verso /dev/null, verso file enorme, verso se stesso ----------------
{
  const dir = path.join(PROG, "d4")
  fs.mkdirSync(dir, { recursive: true })
  fs.symlinkSync("/dev/null", path.join(dir, "state.json"))
  rec("D4 state.json -> /dev/null", `${dir}/state.json`, t("read()", () => BountyState.read(dir).program) + " | " + t("refresh()", () => BountyState.refresh(dir, "d4").phase))
  rec("D4b residui", `ls ${dir}`, JSON.stringify(fs.readdirSync(dir)))
  const dir2 = path.join(PROG, "d4b")
  fs.mkdirSync(dir2, { recursive: true })
  fs.symlinkSync(path.join(dir2, "state.json"), path.join(dir2, "state.json")) // auto-link: ELOOP
  rec("D4b state.json symlink verso SE STESSO (ELOOP)", `${dir2}/state.json`, t("read()", () => BountyState.read(dir2).program) + " | " + t("write()", () => (BountyState.write(BountyState.create({ directory: dir2, program: "d4b" })), "OK")))
  rec("D4c residui", `ls ${dir2}`, JSON.stringify(fs.readdirSync(dir2)))
}

// ---------------- F: sessions()/derive() ----------------
const { Database } = await import("./src/storage/db")
await Instance.provide({
  directory: PROG,
  fn: async () => {
    Database.use((db) => db.run(`create table if not exists _adv (x int)`))
  },
})

// F1: N sessioni con directory DISTINTE che esistono -> costo realpath
await Instance.provide({
  directory: PROG,
  fn: async () => {
    const { Database } = await import("./src/storage/db")
    const dirs: string[] = []
    for (let i = 0; i < 500; i++) {
      const d = path.join(PROG, "f1", `s${i}`)
      fs.mkdirSync(d, { recursive: true })
      dirs.push(d)
    }
    const { SessionTable } = await import("./src/session/session.sql")
    const t0 = performance.now()
    Database.use((db) => {
      const stmt = db.insert(SessionTable)
      for (let i = 0; i < dirs.length; i++) {
        stmt.values({
          id: `ses_advf1_${i}`,
          slug: `advf1-${i}`,
          version: "0.0.0",
          project_id: "advproj",
          directory: dirs[i]!,
          title: `f1 ${i}`,
          time_created: Date.now(),
          time_updated: Date.now(),
        }).run()
      }
    })
    const tIns = performance.now() - t0
    // quante volte canonical() (realpath) viene chiamata? la conto monkeypatchando fs.realpathSync
    const orig = fs.realpathSync
    let calls = 0
    ;(fs as any).realpathSync = (...a: any[]) => {
      calls++
      return (orig as any)(...a)
    }
    const t1 = performance.now()
    const d = BountyState.derive(PROG)
    const t2 = performance.now()
    ;(fs as any).realpathSync = orig
    rec(
      "F1 derive() con 500 sessioni su directory distinte (tutte esistenti)",
      `500 righe inserite in ${tIns.toFixed(0)}ms`,
      `derive(): ${(t2 - t1).toFixed(1)}ms; chiamate realpathSync durante derive = ${calls} (1 per riga +1 per il target); findings=${JSON.stringify(d.findings)}`,
    )
    rec(
      "F1b tempo per 5000 righe (estrapolazione misurata)",
      "5000 sessioni su dir distinte",
      await (async () => {
        const { SessionTable } = await import("./src/session/session.sql")
        const dirs2: string[] = []
        for (let i = 0; i < 4500; i++) {
          const dd = path.join(PROG, "f1", `t${i}`)
          dirs2.push(dd) // NON create: path inesistenti
        }
        Database.use((db) => {
          const stmt = db.insert(SessionTable)
          for (let i = 0; i < dirs2.length; i++)
            stmt.values({ id: `ses_advf1b_${i}`, slug: `f1b-${i}`, version: "0.0.0", project_id: "advproj", directory: dirs2[i]!, title: `t${i}`, time_created: Date.now(), time_updated: Date.now() }).run()
        })
        const t = performance.now()
        BountyState.derive(PROG)
        return `${(performance.now() - t).toFixed(1)}ms per 5000 righe (path inesistenti: realpath fallisce sempre -> eccezione + fallback)`
      })(),
    )
  },
})

// F2: sessione con directory che NON esiste piu' / link rimosso -> fatti azzerati in silenzio?
await Instance.provide({
  directory: PROG,
  fn: async () => {
    const reale = path.join(PROG, "f2-reale")
    fs.mkdirSync(reale, { recursive: true })
    const link = path.join(PROG, "f2-link")
    fs.symlinkSync(reale, link)
    const { SessionTable } = await import("./src/session/session.sql")
    const { CoverageNote } = await import("./src/session/coverage-note")
    const { Database } = await import("./src/storage/db")
    Database.use((db) =>
      db.insert(SessionTable).values({ id: "ses_advf2", slug: "f2", version: "0.0.0", project_id: "advproj", directory: link, title: "f2", time_created: Date.now(), time_updated: Date.now() }).run(),
    )
    CoverageNote.record({ sessionID: "ses_advf2", asset: "https://f2.example.com/x", class: "idor", scope: "local", note: "testato" })
    // 1) link presente
    const a = BountyState.derive(reale)
    const b = BountyState.derive(link)
    rec("F2 con il link PRESENTE", `sessione.directory=${link} (link -> ${reale})`, `derive(reale).targets=${a.targets.length} derive(link).targets=${b.targets.length}`)
    // 2) link RIMOSSO
    fs.rmSync(link)
    const c = BountyState.derive(reale)
    rec(
      "F2b con il link RIMOSSO (sessione orfana nel DB)",
      `sessione.directory=${link} non esiste piu'; si deriva dalla dir REALE`,
      `derive(reale).targets=${c.targets.length}  -> ${c.targets.length === 0 ? "I FATTI SONO SPARITI IN SILENZIO (nessun errore, nessuna divergenza segnalata sul target)" : "ancora presenti"}`,
    )
    // 3) refresh su reale scrive targets=0 come fatto
    fs.writeFileSync(path.join(reale, "state.json"), JSON.stringify({ ...BountyState.create({ directory: reale, program: "f2-reale" }), targets: [{ host: "f2.example.com", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z", sessions: ["ses_advf2"] }] }))
    const r = BountyState.refresh(reale, "f2-reale")
    rec(
      "F2c refresh(reale) dopo la rimozione del link",
      "stato dichiara 1 target con prova",
      `targets scritti=${r.targets.length}; divergences=${JSON.stringify(BountyState.divergences(r, BountyState.derive(reale)))}`,
    )
  },
})

console.log(`\nBASE=${BASE}`)
console.log(`DB=${path.join(process.env["XDG_DATA_HOME"]!, "cyberstrike", "cyberstrike.db")}`)