#!/usr/bin/env python3
"""
SQLITE_MISUSE — riprodurre o escludere la scrittura concorrente.

L'errore che l'utente ha visto:
    SQLITE_MISUSE da bun:sqlite prepare() con byteOffset: -1
    in updateMessage (session/index.ts:657) -> processor.ts:370

Ipotesi: piu' processi CyberStrike sullo stesso cyberstrike.db. Il TUI gira in
new Worker(), quindi main e worker sono due processi distinti che aprono lo
stesso file SQLite in WAL.

Questo NON lancia CyberStrike: scrive direttamente sul db con bun:sqlite,
per isolare la meccanica di sola concorrenza.
"""
import os
import subprocess
import sys
import time
import tempfile
from collections import Counter

BUN = os.path.expanduser("~/.local/share/bun-1.3.9/bin/bun")

# Lo script che ogni writer esegue: apre lo stesso db e scrive, come fa
# updateMessage (insert ... onConflictDoUpdate).
WRITER = """
import {{ Database }} from "bun:sqlite"
const path = process.argv[2]
const tag = process.argv[3]
const n = Number(process.argv[4] || 400)
const errors = []
try {{
  const db = new Database(path, {{ create: true }})
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("CREATE TABLE IF NOT EXISTS m (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
  for (let i = 0; i < n; i++) {{
    try {{
      const stmt = db.query("INSERT INTO m (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      stmt.run(tag + "-" + i, "x".repeat(64))
      stmt.finalize()
    }} catch (e) {{
      errors.push(e.code + ":" + e.message)
    }}
  }}
  console.log(JSON.stringify({{ tag, errors }}))
}} catch (e) {{
  console.log(JSON.stringify({{ tag, fatal: e.message }}))
}}
"""


def main():
    d = tempfile.mkdtemp(prefix="sqlite-race-")
    path = os.path.join(d, "t.db")
    script = os.path.join(d, "w.ts")
    with open(script, "w") as f:
        f.write(WRITER)

    writers = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 4

    print(f"=== {writers} writer concorrenti x {rounds} round, "
          f"db={path} ===")

    all_codes = Counter()
    fatal = 0
    for r in range(rounds):
        procs = [
            subprocess.Popen(
                [BUN, "run", script, path, f"w{k}-r{r}", "400"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for k in range(writers)
        ]
        for p in procs:
            out, err = p.communicate(timeout=120)
            for line in out.splitlines():
                line = line.strip()
                if not line.startswith("{"):
                    continue
                import json
                try:
                    d2 = json.loads(line)
                except Exception:
                    continue
                if d2.get("fatal"):
                    fatal += 1
                    print("  FATALE:", d2["fatal"][:120])
                for e in d2.get("errors", []):
                    all_codes[e.split(":")[0]] += 1
        print(f"  round {r+1}/{rounds} completato")

    print()
    print("=== VERDETTO ===")
    print("  codici di errore raccolti:", dict(all_codes) or "nessuno")
    if "SQLITE_MISUSE" in all_codes:
        print("  RIPRODOTTO: SQLITE_MISUSE con scrittura concorrente")
    else:
        print("  NON riprodotto con scritture concorrenti pulite")
    if fatal:
        print(f"  {fatal} errori fatali (apertura db)")


if __name__ == "__main__":
    main()
