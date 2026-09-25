// ADVERSARIAL PROBE 3 — harness FEDELE: una deny/reject di `ask` ABORTA l'esecuzione.
// Serve a (a) stabilire quali tabelle della PROBE 1 erano irraggiungibili perche'
// il deny esterno abortisce prima, (b) dimostrare il buco `env`/`awk`/`sort`/`find`.
import { BashTool } from "./src/tool/bash"
import { Instance } from "./src/project/instance"
import { PermissionNext } from "./src/permission/next"
import { ProjectPerimeter } from "./src/permission/project"
import { Log } from "./src/util/log"
import fs from "fs/promises"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ROOT = "/tmp/adv3-root"
let pc = 0
let sessionID = ""
let ruleset: PermissionNext.Ruleset = []
type Rec = { permission: string; patterns: string[]; always: string[]; asked: boolean; err?: string }
let recorded: Rec[] = []

async function clickReq(req: any): Promise<void> {
  const id = "per_adv3_" + ++pc
  const rec: Rec = { permission: req.permission, patterns: [...req.patterns], always: [...(req.always ?? [])], asked: false }
  recorded.push(rec)
  let settled: any
  // onRejected RILANCIA: un errore non viene inghiottito.
  const p = PermissionNext.ask({ ...req, id, sessionID, ruleset, metadata: req.metadata ?? {} }).then(
    () => {},
    (e: any) => {
      settled = e
      throw e
    },
  )
  for (let i = 0; i < 400; i++) {
    if ((await PermissionNext.list()).some((x) => x.id === id)) {
      rec.asked = true // l'utente HA VISTO una richiesta
      break
    }
    if (settled) break
    await sleep(5)
  }
  if (rec.asked) await PermissionNext.reply({ requestID: id, reply: "always" })
  try {
    await p // se respinta, si propaga: l'esecuzione si interrompe
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
    ? recs.map((r) => `${r.permission} patterns=${JSON.stringify(r.patterns)} always=${JSON.stringify(r.always)} => asked=${r.asked}${r.err ? " ERR=" + r.err : ""}`).join(" | ")
    : "(nessuna richiesta)"

async function run(cmd: string, tag: string, show = true) {
  recorded = []
  const bash = await BashTool.init()
  let err: any
  let res: any
  try {
    res = await bash.execute({ command: cmd, description: "adv3" }, ctx)
  } catch (e: any) {
    err = e
  }
  if (show)
    console.log(
      `\n### ${tag}\n  INPUT     : ${JSON.stringify(cmd)}\n  ASK       : ${fmt(recorded)}\n  ESECUZIONE: ${
        err ? "BLOCCATA (" + err.constructor?.name + ")" : "exit=" + res?.metadata?.exit
      }`,
    )
  return { records: [...recorded], err }
}

async function phase(label: string, fn: () => Promise<void>) {
  const dir = ROOT + "/" + label
  await fs.mkdir(dir + "/program", { recursive: true })
  await Bun.$`git init -q ${dir}`.quiet()
  await Bun.$`git -C ${dir} commit -q --allow-empty -m root`.quiet()
  const project = dir + "/program"
  console.log(`\n\n=========== FASE ${label} ===========`)
  await Instance.disposeAll().catch(() => {})
  await Instance.provide({
    directory: project,
    fn: async () => {
      const diag = await ProjectPerimeter.diagnose(project)
      ruleset = ProjectPerimeter.buildProjectRuleset(project, diag.worktree)
      sessionID = "ses3_" + label
      await fn()
    },
  })
  await Instance.disposeAll().catch(() => {})
}

async function main() {
  await fs.rm(ROOT, { recursive: true, force: true })
  await fs.mkdir(ROOT, { recursive: true })
  for (const f of ["/tmp/adv3-e", "/tmp/adv3-awk", "/tmp/adv3-find", "/tmp/adv3-tee", "/tmp/adv3-sub"]) await fs.rm(f, { recursive: true, force: true }).catch(() => {})

  // (a) il deny esterno esiste DAVVERO e abortisce prima del bash ask?
  await phase("ORDER", async () => {
    await run("cp /etc/hostname /tmp/adv3-copia", "ORDER cp con path esterno risolto")
    await run("ls -la | tee /tmp/adv3-tee", "ORDER pipe verso tee esterno")
    await run("ls -la; rm -rf /tmp/adv3-x", "ORDER compound con rm su /tmp")
    await run("cat <<< x > /tmp/adv3-heredoc", "ORDER redirect esterno")
    await run("echo x > /tmp/adv3-nodir/z", "ORDER redirect verso path INESISTENTE")
    await run("echo x > $HOME/z", "ORDER redirect con $HOME non risolvibile")
  })

  // (b) IL BUCO: read-only/unknown che scrive fuori, click sempre => permanente
  await phase("ENV", async () => {
    const r1 = await run(`env sh -c 'echo pwned > /tmp/adv3-env'`, "B1 'env sh -c' scrive FUORI")
    await fs.rm("/tmp/adv3-env", { force: true })
    const r2 = await run(`env sh -c 'echo pwned > /tmp/adv3-env'`, "B2 STESSO comando, 2a volta (nessun click)", false)
    console.log(`  B2 richieste: ${fmt(r2.records)}`)
    console.log(`  EVIDENZA: /tmp/adv3-env = ${JSON.stringify(await Bun.file("/tmp/adv3-env").text().catch(() => "ASSENTE"))}`)
    console.log(`  => ${r2.records.length === 0 ? "PERMANENTE E SILENZIOSO (scrittura FUORI progetto senza alcuna conferma)" : "ri-chiede"}`)
  })

  await phase("AWK", async () => {
    const r1 = await run(`awk 'BEGIN{print "pwned" > "/tmp/adv3-awk"}'`, "C1 'awk' scrive FUORI")
    await fs.rm("/tmp/adv3-awk", { force: true })
    const r2 = await run(`awk 'BEGIN{print "pwned" > "/tmp/adv3-awk"}'`, "C2 STESSO comando, 2a volta", false)
    console.log(`  C2 richieste: ${fmt(r2.records)}`)
    console.log(`  EVIDENZA: /tmp/adv3-awk = ${JSON.stringify(await Bun.file("/tmp/adv3-awk").text().catch(() => "ASSENTE"))}`)
  })

  await phase("FIND", async () => {
    await fs.writeFile(ROOT + "/FIND/importante.txt", "x\n")
    const r1 = await run(`find ${ROOT}/FIND -name importante.txt -delete`, "D1 'find -delete' distrugge FUORI")
    const r2 = await run(`find ${ROOT}/FIND -name importante.txt -delete`, "D2 STESSO comando, 2a volta", false)
    console.log(`  D2 richieste: ${fmt(r2.records)}`)
    console.log(`  EVIDENZA: importante.txt esiste ancora? ${await Bun.file(ROOT + "/FIND/importante.txt").exists()}`)
  })

  // (c) compound: la SECONDA istruzione viene resa permanente?
  await phase("COMPOUND", async () => {
    const r1 = await run(`ls -la; env sh -c 'echo pwned > /tmp/adv3-cmp'`, "E1 compound 'ls -la; env sh -c ...'")
    await fs.rm("/tmp/adv3-cmp", { force: true })
    const r2 = await run(`env sh -c 'echo pwned > /tmp/adv3-cmp'`, "E2 esegui SOLO la 2a istruzione, senza click", false)
    console.log(`  E2 richieste: ${fmt(r2.records)}`)
    console.log(`  EVIDENZA: /tmp/adv3-cmp = ${JSON.stringify(await Bun.file("/tmp/adv3-cmp").text().catch(() => "ASSENTE"))}`)
    console.log("  (se E2 e' 0 richieste: un click sul compound ha reso permanente la 2a istruzione)")
  })

  // (d) la FAMIGLIA sullo stesso comando e' filtrata; l'esatto no. Il click e' un no-op o crea un allow?
  await phase("FAMILY", async () => {
    const r1 = await run(`env sh -c 'echo a > /tmp/adv3-fam1'`, "F1 concedi 'env sh -c ...fam1'")
    const r2 = await run(`env sh -c 'echo b > /tmp/adv3-fam2'`, "F2 comando DIVERSO (fam2), nessun click", false)
    console.log(`  F2 richieste: ${fmt(r2.records)}`)
    const r3 = await run(`env sh -c 'echo a > /tmp/adv3-fam1'`, "F3 torna al comando ESATTO concesso", false)
    console.log(`  F3 richieste: ${fmt(r3.records)} (0 = la concessione esatta e' permanente)`)
  })

  await Instance.disposeAll().catch(() => {})
  console.log("\n\n########## FINE PROBE 3 ##########")
}

Log.init({ print: false, level: "ERROR" } as any).catch(() => {})
await main()