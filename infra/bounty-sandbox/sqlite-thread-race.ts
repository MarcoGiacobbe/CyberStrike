// Due thread Bun, due handle bun:sqlite distinti, stesso file WAL.
// Replica la condizione reale: main + Worker (thread.ts:112) che aprono
// entrambi cyberstrike.db. CyberStrike non chiama mai close().
//
// Uso: bun run sqlite-thread-race.ts <path.db> [N] [round]
import { Database } from "bun:sqlite"

const path = process.argv[2] ?? "/tmp/thread-race.db"
const N = Number(process.argv[3] ?? 300)
const ROUND = Number(process.argv[4] ?? 3)
const SQL =
  "INSERT INTO m (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data"

// Il worker non vede argv: riceve tutto via message.
const workerSrc = `
  const SQL = ${JSON.stringify(SQL)}
  let path, N
  const onmessage = (e) => {
    const d = e.data
    if (d.type === "go") { path = d.path; N = d.n }
    const out = { prepareErr: null, runErr: null, rows: 0 }
    try {
      const db = new Database(path, { create: true })
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA busy_timeout = 5000")
      db.run("CREATE TABLE IF NOT EXISTS m (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
      for (let i = 0; i < N; i++) {
        try {
          db.query(SQL).run("w" + i, "d".repeat(200))   // <- prepare()
        } catch (e) {
          if (!out.prepareErr) out.prepareErr = (e.code || "?") + ": " + e.message
        }
      }
      out.rows = db.query("SELECT count(*) c FROM m").get().c
    } catch (e) { out.runErr = (e.code || "?") + ": " + e.message }
    postMessage(out)
  }
  onmessage({ data: { type: "go", path: "", n: 0 } })
`

function writeSide(tag: string): Promise<{ prepareErr: string | null; runErr: string | null; rows: number }> {
  return new Promise((resolve) => {
    const out = { prepareErr: null as string | null, runErr: null as string | null, rows: 0 }
    try {
      const db = new Database(path, { create: true })
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA busy_timeout = 5000")
      db.run("CREATE TABLE IF NOT EXISTS m (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
      for (let i = 0; i < N; i++) {
        try {
          db.query(SQL).run(tag + i, "d".repeat(200))     // <- prepare()
        } catch (e) {
          if (!out.prepareErr) out.prepareErr = (e.code || "?") + ": " + e.message
        }
      }
      out.rows = db.query("SELECT count(*) c FROM m").get().c
    } catch (e) { out.runErr = (e.code || "?") + ": " + e.message }
    resolve(out)
  })
}

console.log(`=== 2 thread, ${N} scritture ciascuno x ${ROUND} round, db=${path} ===`)
const seen = new Set<string>()
let misuse = 0

for (let r = 0; r < ROUND; r++) {
  const w = new Worker(new URL("./sqlite-worker.ts", import.meta.url).href)
  const done = new Promise<any>((res) => {
    w.onmessage = (e) => res(e.data)
    w.onerror = (e: any) => {
      console.log("  worker onerror: " + (e?.message ?? JSON.stringify(e)))
      res({ prepareErr: "WORKER ERROR: " + (e?.message ?? "?"), runErr: null, rows: -1 })
    }
    setTimeout(() => res({ prepareErr: "TIMEOUT: worker non ha risposto", runErr: null, rows: -1 }), 60000)
  })
  w.postMessage({ type: "go", path, n: N })
  const [main, work] = await Promise.all([writeSide("m"), done])
  w.terminate()

  const errs = [main.prepareErr, main.runErr, work.prepareErr, work.runErr].filter(Boolean) as string[]
  for (const e of errs) seen.add(e.split(":")[0])
  if (errs.some((e) => e.includes("SQLITE_MISUSE"))) misuse++
  console.log(
    `  round ${r + 1}/${ROUND}  main.rows=${main.rows} worker.rows=${work.rows}  errori=${errs.length}`,
  )
  for (const e of errs) console.log("      " + e.slice(0, 140))
}

console.log("\n=== VERDETTO ===")
console.log("  codici: " + (seen.size ? [...seen].join(", ") : "nessuno"))
console.log(
  misuse > 0
    ? `  RIPRODOTTO: SQLITE_MISUSE in ${misuse}/${ROUND} round`
    : "  NON riprodotto con 2 thread sullo stesso file WAL",
)
