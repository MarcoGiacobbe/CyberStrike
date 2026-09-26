// Worker REALE, su file, che apre bun:sqlite — la stessa forma di
// packages/cyberstrike/src/cli/cmd/tui/worker.ts. Un Worker inline non puo'
// importare bun:sqlite: muore con AggregateError. Questo file e' quello che
// serve per mettere davvero due thread sullo stesso DB.
import { Database } from "bun:sqlite"

const SQL =
  "INSERT INTO m (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data"

const out = { prepareErr: null as string | null, runErr: null as string | null, rows: 0 }

onmessage = (e: MessageEvent) => {
  const { path, n } = e.data
  try {
    const db = new Database(path, { create: true })
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("CREATE TABLE IF NOT EXISTS m (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    for (let i = 0; i < n; i++) {
      try {
        db.query(SQL).run("w" + i, "d".repeat(200)) // <- prepare()
      } catch (err: any) {
        if (!out.prepareErr) out.prepareErr = (err.code || "?") + ": " + err.message
      }
    }
    out.rows = db.query("SELECT count(*) c FROM m").get().c
  } catch (err: any) {
    out.runErr = (err.code || "?") + ": " + err.message
  }
  postMessage(out)
}
