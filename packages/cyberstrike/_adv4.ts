// ADVERSARIAL PROBE 4 — conferme puntuali.
import { BashTool } from "./src/tool/bash"
import { Instance } from "./src/project/instance"
import { PermissionNext } from "./src/permission/next"
import { ProjectPerimeter } from "./src/permission/project"
import { Log } from "./src/util/log"
import fs from "fs/promises"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ROOT = "/tmp/adv4-root"
let pc = 0
let sessionID = ""
let ruleset: PermissionNext.Ruleset = []
type Rec = { permission: string; patterns: string[]; always: string[]; asked: boolean; err?: string }
let recorded: Rec[] = []

async function clickReq(req: any): Promise<void> {
  const id = "per_adv4_" + ++pc
  const rec: Rec = { permission: req.permission, patterns: [...req.patterns], always: [...(req.always ?? [])], asked: false }
  recorded.push(rec)
  let settled: any
  const p = PermissionNext.ask({ ...req, id, sessionID, ruleset, metadata: req.metadata ?? {} }).then(
    () => {},
    (e: any) => {
      settled = e
      throw e
    },
  )
  for (let i = 0; i < 400; i++) {
    if ((await PermissionNext.list()).some((x) => x.id === id)) {
      rec.asked = true
      break
    }
    if (settled) break
    await sleep(5)
  }
  if (rec.asked) await PermissionNext.reply({ requestID: id, reply: "always" })
  try {
    await p
  } catch (e: any) {
    rec.err = e?.constructor?.name ?? String(e)
    throw e
  }
}

const ctx: any = {
  sessionID: "t",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: (req: any) => clickReq(req),
}

const fmt = (recs: Rec[]) =>
  recs.length
    ? recs
        .map((r) => `${r.permission} patterns=${JSON.stringify(r.patterns)} always=${JSON.stringify(r.always)} asked=${r.asked}${r.err ? " ERR=" + r.err : ""}`)
        .join(" | ")
    : "(nessuna richiesta)"

async function run(cmd: string, tag: string, show = true) {
  recorded = []
  const bash = await BashTool.init()
  let err: any
  let res: any
  try {
    res = await bash.execute({ command: cmd, description: "adv4" }, ctx)
  } catch (e: any) {
    err = e
  }
  if (show) console.log(`\n### ${tag}\n  INPUT     : ${JSON.stringify(cmd)}\n  ASK       : ${fmt(recorded)}\n  ESECUZIONE: ${err ? "BLOCCATA (" + err.constructor?.name + ")" : "exit=" + res?.metadata?.exit}`)
  return { records: [...recorded], err }
}

async function phase(label: string, fn: () => Promise<void>) {
  const dir = ROOT + "/" + label
  await fs.mkdir(dir + "/program", { recursive: true })
  await Bun.$`git init -q ${dir}`.quiet()
  await Bun.$`git -C ${dir} commit -q --allow-empty -m root`.quiet()
  await Instance.disposeAll().catch(() => {})
  await Instance.provide({
    directory: dir + "/program",
    fn: async () => {
      const diag = await ProjectPerimeter.diagnose(dir + "/program")
      ruleset = ProjectPerimeter.buildProjectRuleset(dir + "/program", diag.worktree)
      sessionID = "ses4_" + label
      console.log(`\n=========== FASE ${label} ===========`)
      await fn()
    },
  })
  await Instance.disposeAll().catch(() => {})
}

async function main() {
  await fs.rm(ROOT, { recursive: true, force: true })
  await fs.mkdir(ROOT, { recursive: true })

  await phase("WILD", async () => {
    await run("ls *.txt", "W1 'ls *.txt': il pattern ESATTO contiene un '*': concesso?")
    const r2 = await run("ls *.txt", "W2 identico, 2a volta", false)
    console.log(`  W2: ${fmt(r2.records)}`)
    console.log(`  => ${r2.records.some((r) => r.asked) ? "ri-chiede (l'esatto con '*' e' filtrato da voidsBoundary)" : "concesso"}`)
  })

  await phase("HOME", async () => {
    const realHOME = process.env.HOME
    process.env.HOME = ROOT + "/HOME/fakehome"
    await fs.mkdir(ROOT + "/HOME/fakehome", { recursive: true })
    await run("echo x > $HOME/z", "H1 'echo x > $HOME/z'")
    const r2 = await run("echo x > $HOME/z", "H2 identico, 2a volta", false)
    process.env.HOME = realHOME
    console.log(`  H2: ${fmt(r2.records)}`)
    console.log("  file scritto:", await Bun.file(ROOT + "/HOME/fakehome/z").exists())
  })

  await phase("UNRES", async () => {
    await run("mkdir -p /tmp/adv4-nodir", "U1 mkdir dir esterna INESISTENTE (realpath fallisce)")
    const r2 = await run("mkdir -p /tmp/adv4-nodir", "U2 identico, 2a volta", false)
    console.log(`  U2: ${fmt(r2.records)}`)
  })

  await phase("PERM", async () => {
    await run(`python3 -c "open('/tmp/adv4-p','w')"`, "P1 opaque python3 (bash + bash_unresolved)")
    const r2 = await run(`python3 -c "open('/tmp/adv4-p','w')"`, "P2 identico, 2a volta", false)
    console.log(`  P2: ${fmt(r2.records)}`)
    console.log("  => bash_unresolved ri-chiede?:", r2.records.some((r) => r.permission === "bash_unresolved" && r.asked))
  })

  await Instance.disposeAll().catch(() => {})
  console.log("\n########## FINE PROBE 4 ##########")
}

Log.init({ print: false, level: "ERROR" } as any).catch(() => {})
await main()