// ADVERSARIAL PROBE — ATTACCO al nuovo `always` di bash.ts (comando esatto primo)
// NON e' un test runner: script diretto, lanciato con `bun run`.
//
// Isolamento: ogni FASE usa un progetto (directory) diverso, cosi' lo stato
// `approved` di PermissionNext (per Instance.directory) non si mescola.
import { BashTool } from "./src/tool/bash"
import { Instance } from "./src/project/instance"
import { PermissionNext } from "./src/permission/next"
import { ProjectPerimeter } from "./src/permission/project"
import { Bus } from "./src/bus"
import { Log } from "./src/util/log"
import fs from "fs/promises"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ROOT = "/tmp/adv-root"

type Rec = { permission: string; patterns: string[]; always: string[]; asked: boolean; onError?: string }

let pc = 0
let sessionID = ""
let ruleset: PermissionNext.Ruleset = []
let mode: "always" | "once" = "always"
let recorded: Rec[] = []
let busEvents: any[] = []

async function clickReq(req: any): Promise<void> {
  const id = "per_adv_" + ++pc
  const rec: Rec = {
    permission: req.permission,
    patterns: [...req.patterns],
    always: [...(req.always ?? [])],
    asked: false,
  }
  recorded.push(rec)
  const settled: { ok: boolean; err?: any } = { ok: false }
  const p = PermissionNext.ask({ ...req, id, sessionID, ruleset, metadata: req.metadata ?? {} }).then(
    () => {
      settled.ok = true
    },
    (e: any) => {
      settled.err = e
    },
  )
  for (let i = 0; i < 400; i++) {
    if ((await PermissionNext.list()).some((x) => x.id === id)) {
      rec.asked = true
      break
    }
    if (settled.ok || settled.err) break
    await sleep(5)
  }
  if (rec.asked) await PermissionNext.reply({ requestID: id, reply: mode })
  // Fedele al sistema reale: un reject/deny di `ask` DEVE propagare al tool e
  // interrompere l'esecuzione. Non lo si inghiotte.
  try {
    await p
  } catch (e: any) {
    rec.onError = e?.constructor?.name ?? String(e)
    throw e
  }
}

const ctx: any = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: (req: any) => clickReq(req),
}

/** allow / ask / deny / errore, senza consumare il click "always". */
async function probe(permission: string, pattern: string) {
  const id = "per_probe_" + ++pc
  let state = "allow"
  const p = PermissionNext.ask({
    id,
    sessionID,
    permission,
    patterns: [pattern],
    always: [],
    metadata: {},
    ruleset,
  } as any).then(
    () => {
      state = "allow"
    },
    (e: any) => {
      state = "DENIED(" + (e?.constructor?.name ?? String(e)) + ")"
    },
  )
  await sleep(30)
  const pend = (await PermissionNext.list()).find((x) => x.id === id)
  if (pend) await PermissionNext.reply({ requestID: id, reply: "reject" })
  await p
  return pend ? "ask" : state
}

function fmtA(recs: Rec[]) {
  if (!recs.length) return "(nessuna richiesta: nessun ask)"
  return recs
    .map(
      (r) =>
        `${r.permission} patterns=${JSON.stringify(r.patterns)} always=${JSON.stringify(r.always)} pending=${r.asked}${
          r.onError ? " ERR=" + r.onError : ""
        }`,
    )
    .join(" | ")
}

async function run(cmd: string, tag: string, show = true) {
  recorded = []
  const bash = await BashTool.init()
  let err: any
  let res: any
  try {
    res = await bash.execute({ command: cmd, description: "adv probe" }, ctx)
  } catch (e: any) {
    err = e
  }
  if (show) {
    console.log(`\n### ${tag}`)
    console.log(`  INPUT    : ${JSON.stringify(cmd)}`)
    console.log(`  ASK      : ${fmtA(recorded)}`)
    console.log(`  ESECUZIONE: ${err ? "THREW " + (err?.constructor?.name ?? "") + ": " + String(err?.message).slice(0, 120) : "exit=" + res?.metadata?.exit}${err ? "" : " out=" + JSON.stringify(String(res?.metadata?.output ?? "").slice(0, 50))}`)
  }
  return { records: [...recorded], err, res }
}

/** Fase isolata: nuova directory di progetto => nuovo stato `approved`. */
async function phase(label: string, fn: () => Promise<void>, perimeter = true) {
  const dir = ROOT + "/" + label
  await fs.mkdir(dir + "/program", { recursive: true })
  await Bun.$`git init -q ${dir}`.quiet()
  await Bun.$`git -C ${dir} commit -q --allow-empty -m root`.quiet()
  const project = dir + "/program"
  console.log(`\n\n================ FASE ${label} ================`)
  await Instance.disposeAll().catch(() => {})
  await Instance.provide({
    directory: project,
    fn: async () => {
      const diag = await ProjectPerimeter.diagnose(project)
      ruleset = perimeter ? ProjectPerimeter.buildProjectRuleset(project, diag.worktree) : []
      sessionID = "ses_" + label
      mode = "always"
      await fn()
    },
  })
  await Instance.disposeAll().catch(() => {})
}

async function main() {
  await fs.rm(ROOT, { recursive: true, force: true })
  await fs.mkdir(ROOT, { recursive: true })
  for (const f of [
    "/tmp/adv-x",
    "/tmp/adv-y",
    "/tmp/adv-copia",
    "/tmp/adv-e",
    "/tmp/adv-awk",
    "/tmp/adv-sort",
    "/tmp/adv-tee",
    "/tmp/adv-tee2",
    "/tmp/adv-heredoc",
    "/tmp/adv-sub",
    "/tmp/a",
    "/tmp/bbbb",
  ])
    await fs.rm(f, { force: true }).catch(() => {})

  // ==================== A ====================
  await phase("A1", async () => {
    await fs.writeFile("/tmp/adv-x", "")
    await run(`python3 -c "open('/tmp/adv-x','w')"`, "A1 python3 -c OPAQUE che scrive FUORI (/tmp/adv-x)")
    console.log("  probe bash exact            :", await probe("bash", `python3 -c "open('/tmp/adv-x','w')"`))
    console.log("  probe bash family 'python3 *':", await probe("bash", "python3 *"))
    console.log("  probe bash_unres exact      :", await probe("bash_unresolved", `python3 -c "open('/tmp/adv-x','w')"`))
    console.log("  probe bash_unres family     :", await probe("bash_unresolved", "python3 *"))
    const r2 = await run(`python3 -c "open('/tmp/adv-x','w')"`, "A1b STESSO comando, 2a volta", false)
    console.log(`  A1b richieste 2a volta: ${fmtA(r2.records)}`)
    console.log("  /tmp/adv-x esiste (fuori progetto):", await Bun.file("/tmp/adv-x").exists())
  })

  await phase("A2", async () => {
    await run(`sh -c 'echo x > /tmp/adv-y'`, "A2 sh -c OPAQUE che scrive FUORI")
    const r2 = await run(`sh -c 'echo x > /tmp/adv-y'`, "A2b idem, 2a volta", false)
    console.log(`  A2b richieste 2a volta: ${fmtA(r2.records)}`)
    console.log("  /tmp/adv-y:", JSON.stringify(await Bun.file("/tmp/adv-y").text().catch(() => "ASSENTE")))
  })

  await phase("A3", async () => {
    const realHOME = process.env.HOME
    process.env.HOME = ROOT + "/A3/fakehome"
    await fs.mkdir(ROOT + "/A3/fakehome", { recursive: true })
    const r1 = await run("echo x > $HOME/z", "A3 path NON risolvibile ($HOME)")
    const r2 = await run("echo x > $HOME/z", "A3b idem, 2a volta", false)
    process.env.HOME = realHOME
    console.log(`  A3b richieste 2a volta: ${fmtA(r2.records)}`)
    console.log("  file scritto:", await Bun.file(ROOT + "/A3/fakehome/z").exists())
  })

  await phase("A4", async () => {
    await run("cp /etc/hostname /tmp/adv-copia", "A4 write con path esterno RISOLTO")
    const r2 = await run("cp /etc/hostname /tmp/adv-copia", "A4b idem, 2a volta", false)
    console.log(`  A4b richieste 2a volta: ${fmtA(r2.records)}`)
    console.log("  /tmp/adv-copia:", await Bun.file("/tmp/adv-copia").exists())
  })

  await phase("A5", async () => {
    await run(`env python3 -c "open('/tmp/adv-e','w')"`, "A5 'env' (READ_ONLY) + python3 che scrive FUORI")
    const r2 = await run(`env python3 -c "open('/tmp/adv-e','w')"`, "A5b idem, 2a volta", false)
    console.log(`  A5b richieste 2a volta: ${fmtA(r2.records)}`)
    console.log("  /tmp/adv-e scritto FUORI con un click 'sempre':", await Bun.file("/tmp/adv-e").exists())
  })

  await phase("A6", async () => {
    await run(`awk 'BEGIN{print "x" > "/tmp/adv-awk"}'`, "A6 'awk' (READ_ONLY) che scrive FUORI con redirect interno")
    const r2 = await run(`awk 'BEGIN{print "x" > "/tmp/adv-awk"}'`, "A6b idem, 2a volta", false)
    console.log(`  A6b richieste 2a volta: ${fmtA(r2.records)}`)
    console.log("  /tmp/adv-awk scritto FUORI:", await Bun.file("/tmp/adv-awk").exists())
  })

  await phase("A7", async () => {
    await run("sort -o /tmp/adv-sort /etc/hostname", "A7 'sort -o' (READ_ONLY) scrive FUORI")
    const r2 = await run("sort -o /tmp/adv-sort /etc/hostname", "A7b idem, 2a volta", false)
    console.log(`  A7b richieste 2a volta: ${fmtA(r2.records)}`)
    console.log("  /tmp/adv-sort scritto FUORI:", await Bun.file("/tmp/adv-sort").exists())
  })

  await phase("A8", async () => {
    await fs.writeFile(ROOT + "/A8/vittima.txt", "importante\n")
    await run(`find ${ROOT}/A8 -name vittima.txt -delete`, "A8 'find -delete' (unknown) distrugge FUORI progetto")
    const r2 = await run(`find ${ROOT}/A8 -name vittima.txt -delete`, "A8b idem, 2a volta", false)
    console.log(`  A8b richieste 2a volta: ${fmtA(r2.records)}`)
    console.log("  vittima cancellata FUORI:", !(await Bun.file(ROOT + "/A8/vittima.txt").exists()))
  })

  await phase("A3q", async () => {
    const realHOME = process.env.HOME
    process.env.HOME = ROOT + "/A3q/fakehome"
    await fs.mkdir(ROOT + "/A3q/fakehome", { recursive: true })
    const r1 = await run('echo x > "$HOME/z"', "A3q redirect QUOTED con $HOME")
    const r2 = await run('echo x > "$HOME/z"', "A3q-b idem, 2a volta", false)
    process.env.HOME = realHOME
    console.log(`  A3q-b richieste 2a volta: ${fmtA(r2.records)}`)
    console.log("  file scritto:", await Bun.file(ROOT + "/A3q/fakehome/z").exists())
  })

  await phase("A9", async () => {
    const r1 = await run("echo x > /tmp/adv-nodir/z", "A9 redirect verso dir INESISTENTE (realpath fallisce)")
    const r2 = await run("echo x > /tmp/adv-nodir/z", "A9b idem, 2a volta", false)
    console.log(`  A9b richieste 2a volta: ${fmtA(r2.records)}`)
  })

  await phase("A10", async () => {
    const r1 = await run(`bash -c 'python3 -c "open(\`/tmp/adv-b\`,\`w\`).write(1)"'`, "A10 bash -c annidato (contenitore OPAQUE)")
    const r2 = await run(`bash -c 'python3 -c "open(\`/tmp/adv-b\`,\`w\`).write(1)"'`, "A10b idem, 2a volta", false)
    console.log(`  A10b richieste 2a volta: ${fmtA(r2.records)}`)
    console.log("  /tmp/adv-b:", await Bun.file("/tmp/adv-b").exists())
  })

  // ==================== B ====================
  await phase("B", async () => {
    await run("ls -la", "B1 concedi 'ls -la'")
    console.log("  probe 'ls -la'          :", await probe("bash", "ls -la"))
    console.log("  probe 'ls -la /etc'     :", await probe("bash", "ls -la /etc"))
    console.log("  probe 'ls'              :", await probe("bash", "ls"))
    console.log("  probe 'ls -la; whoami'  :", await probe("bash", "ls -la; whoami"))
    const r2 = await run("ls -la /etc", "B2 esegui 'ls -la /etc' (dopo aver concesso 'ls -la')", false)
    console.log(`  B2 richieste: ${fmtA(r2.records)}`)
    await run(`python3 -c "open('/tmp/a','w')"`, "B3 concedi python3 -c open('/tmp/a','w') (path INESISTENTE)")
    console.log("  probe bash_unres 'bbbb' :", await probe("bash_unresolved", `python3 -c "open('/tmp/bbbb','w')"`))
    console.log("  probe bash_unres identico:", await probe("bash_unresolved", `python3 -c "open('/tmp/a','w')"`))
    console.log("  probe bash identico      :", await probe("bash", `python3 -c "open('/tmp/a','w')"`))
    const r4 = await run(`python3 -c "open('/tmp/a','w')"`, "B4 riesegui identico", false)
    console.log(`  B4 richieste: ${fmtA(r4.records)}`)
  })

  // ==================== C ====================
  await phase("C1", async () => {
    await fs.writeFile(ROOT + "/C1/program/secondo.txt", "x\n")
    await run("ls -la; rm -f ./secondo.txt", "C1 separatore ';' (entrambi interni)")
    const r2 = await run("ls -la; rm -f ./secondo.txt", "C1b idem, 2a volta", false)
    console.log(`  C1b richieste: ${fmtA(r2.records)}`)
    console.log("  probe 'rm -f ./secondo.txt' standalone:", await probe("bash", "rm -f ./secondo.txt"))
  })

  await phase("C2", async () => {
    await run("ls -la && cat /etc/passwd", "C2 '&& cat /etc/passwd'")
    console.log("  probe 'cat /etc/passwd' standalone:", await probe("bash", "cat /etc/passwd"))
  })

  await phase("C3", async () => {
    await run("ls -la | tee /tmp/adv-tee", "C3 pipe verso tee ESTERNO (file inesistente)")
    const r2 = await run("ls -la | tee /tmp/adv-tee", "C3b idem, 2a volta", false)
    console.log(`  C3b richieste: ${fmtA(r2.records)}`)
    console.log("  /tmp/adv-tee creato FUORI:", await Bun.file("/tmp/adv-tee").exists())
  })

  await phase("C4", async () => {
    await fs.mkdir(ROOT + "/C4/ext", { recursive: true })
    await fs.writeFile(ROOT + "/C4/ext/pipe.txt", "y\n")
    await run(`ls -la | tee ${ROOT}/C4/ext/pipe.txt`, "C4 pipe verso tee ESTERNO (file ESISTENTE)")
    const r2 = await run(`ls -la | tee ${ROOT}/C4/ext/pipe.txt`, "C4b idem, 2a volta", false)
    console.log(`  C4b richieste: ${fmtA(r2.records)}`)
  })

  await phase("C5", async () => {
    await run("ls -la; rm -rf /tmp/x", "C5 'ls -la; rm -rf /tmp/x'")
    const r2 = await run("ls -la; rm -rf /tmp/x", "C5b idem, 2a volta", false)
    console.log(`  C5b richieste (il compound passa senza chiedere?): ${fmtA(r2.records)}`)
  })

  await phase("C6", async () => {
    await run("ls -la; rm -rf /etc/adv-inesistente", "C6 'ls -la; rm -rf /etc/adv-inesistente'")
    const r2 = await run("ls -la; rm -rf /etc/adv-inesistente", "C6b idem, 2a volta", false)
    console.log(`  C6b richieste: ${fmtA(r2.records)}`)
  })

  // ==================== E ====================
  await phase("E", async () => {
    await run("ls $(cat /etc/hostname)", "E1 command substitution")
    await run("ls `pwd`", "E2 backtick")
    await run("cat <<< 'x' > /tmp/adv-heredoc", "E3 herestring + redirect esterno")
    await run("tee /tmp/adv-tee2 <<< x", "E4 tee herestring")
    await run(`echo $(python3 -c "open('/tmp/adv-sub','w')")`, "E5 substitution con python3 OPAQUE dentro")
    const r2 = await run(`echo $(python3 -c "open('/tmp/adv-sub','w')")`, "E5b idem, 2a volta", false)
    console.log(`  E5b richieste: ${fmtA(r2.records)}`)
    console.log("  /tmp/adv-sub scritto FUORI:", await Bun.file("/tmp/adv-sub").exists())
  })

  // ==================== F ====================
  await phase(
    "F",
    async () => {
      console.log("  (FUORI perimetro: ruleset vuoto)")
      await run("ls -la", "F1 FUORI perimetro: concedi 'ls -la'")
      console.log("  probe 'ls -la'          :", await probe("bash", "ls -la"))
      console.log("  probe 'ls'              :", await probe("bash", "ls"))
      console.log("  probe 'ls -la /etc'     :", await probe("bash", "ls -la /etc"))
      const f2 = await run("ls -la /etc", "F2 'ls -la /etc' dopo la concessione", false)
      console.log(`  F2 richieste: ${fmtA(f2.records)}`)
      const f3 = await run("ls", "F3 'ls' dopo la concessione di 'ls -la'", false)
      console.log(`  F3 richieste: ${fmtA(f3.records)}`)
    },
    false,
  )

  // ==================== D: trasparenza ====================
  await phase("D", async () => {
    busEvents = []
    Bus.subscribe(PermissionNext.Event.Replied, (e: any) => busEvents.push(e.properties))
    await run("echo ciao", "D1 'echo ciao' -> family 'echo *' filtrata")
    console.log("  probe 'echo ciao' :", await probe("bash", "echo ciao"))
    console.log("  probe 'echo altro':", await probe("bash", "echo altro"))
    console.log("  eventi permission.replied:", JSON.stringify(busEvents))
    console.log(
      "  evento contiene l'info della family filtrata?:",
      JSON.stringify(busEvents).includes("echo *") || JSON.stringify(busEvents).includes("limited"),
    )
  })

  await Instance.disposeAll().catch(() => {})
  console.log("\n\n########## FINE PROBE ##########")
}

Log.init({ print: false, level: "ERROR" } as any).catch(() => {})
await main()