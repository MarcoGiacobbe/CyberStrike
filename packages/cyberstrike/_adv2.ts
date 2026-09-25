// ADVERSARIAL PROBE 2 — comandi classificati READ-ONLY/unknown che SCRIVONO fuori
// progetto: il click "sempre" sul COMANDO ESATTO li rende permanenti?
// Script diretto: `bun run`.
import { BashTool } from "./src/tool/bash"
import { Instance } from "./src/project/instance"
import { PermissionNext } from "./src/permission/next"
import { ProjectPerimeter } from "./src/permission/project"
import { Log } from "./src/util/log"
import fs from "fs/promises"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ROOT = "/tmp/adv2-root"

let pc = 0
let sessionID = ""
let ruleset: PermissionNext.Ruleset = []

type Rec = { permission: string; patterns: string[]; always: string[]; asked: boolean; err?: string }
let recorded: Rec[] = []

async function clickReq(req: any): Promise<void> {
  const id = "per_adv2_" + ++pc
  const rec: Rec = { permission: req.permission, patterns: [...req.patterns], always: [...(req.always ?? [])], asked: false }
  recorded.push(rec)
  const settled: any = {}
  const p = PermissionNext.ask({ ...req, id, sessionID, ruleset, metadata: req.metadata ?? {} }).then(
    () => (settled.ok = true),
    (e: any) => (settled.err = e),
  )
  for (let i = 0; i < 400; i++) {
    if ((await PermissionNext.list()).some((x) => x.id === id)) {
      rec.asked = true
      break
    }
    if (settled.ok || settled.err) break
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

function fmt(recs: Rec[]) {
  if (!recs.length) return "(nessuna richiesta)"
  return recs
    .map(
      (r) =>
        `${r.permission} patterns=${JSON.stringify(r.patterns)} always=${JSON.stringify(r.always)} pending=${r.asked}${
          r.err ? " ERR=" + r.err : ""
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
    res = await bash.execute({ command: cmd, description: "adv2" }, ctx)
  } catch (e: any) {
    err = e
  }
  if (show)
    console.log(
      `\n### ${tag}\n  INPUT     : ${JSON.stringify(cmd)}\n  ASK       : ${fmt(recorded)}\n  ESECUZIONE: ${
        err ? "THREW " + err.constructor?.name : "exit=" + res?.metadata?.exit
      }`,
    )
  return { records: [...recorded], err }
}

/**
 * Prova del "silenzio permanente": 1a esecuzione (click sempre) -> crea un
 * SECONDO artefatto a path esterno -> 2a esecuzione IDENTICA -> se l'artefatto
 * sparisce/compare senza alcuna richiesta, la concessione e' permanente.
 */
async function permanence(label: string, cmd: string, evidence: () => Promise<string>, arm: () => Promise<void>) {
  const r1 = await run(cmd, label + " — 1a esecuzione (click sempre)", true)
  await arm()
  const r2 = await run(cmd, label + " — 2a esecuzione IDENTICA", true)
  const asked2 = r2.records.filter((r) => (r as any).asked).length
  console.log(`  EVIDENZA FUORI PROGETTO : ${await evidence()}`)
  console.log(
    `  VERDETTO                : ${
      asked2 === 0
        ? "PERMANENTE E SILENZIOSO (nessuna richiesta alla 2a esecuzione)"
        : "ri-chiede (" + asked2 + " richieste)"
    }`,
  )
}

async function phase(label: string, fn: () => Promise<void>) {
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
      ruleset = ProjectPerimeter.buildProjectRuleset(project, diag.worktree)
      sessionID = "ses2_" + label
      await fn()
    },
  })
  await Instance.disposeAll().catch(() => {})
}

async function main() {
  await fs.rm(ROOT, { recursive: true, force: true })
  await fs.mkdir(ROOT, { recursive: true })
  for (const f of ["/tmp/adv-key", "/tmp/adv-key.pub", "/tmp/adv-openssl", "/tmp/adv-gitrepo", "/tmp/adv-hook", "/tmp/adv-w"])
    await fs.rm(f, { recursive: true, force: true }).catch(() => {})

  // ---------- awk: READ_ONLY, scrive con redirect dentro il programma ----------
  await phase("AWK", async () => {
    await permanence(
      "awk (READ_ONLY) con redirect interno nel programma",
      `awk 'BEGIN{print "x" > "/tmp/adv-w"}'`,
      async () => `contenuto /tmp/adv-w = ${JSON.stringify(await Bun.file("/tmp/adv-w").text().catch(() => "ASSENTE"))}`,
      async () => {
        await fs.rm("/tmp/adv-w", { force: true })
        console.log("  [arm] /tmp/adv-w rimosso; sara' ricreato dalla 2a esecuzione se la concessione e' permanente")
      },
    )
  })

  // ---------- sort -o ----------
  await phase("SORT", async () => {
    await permanence(
      "sort -o (READ_ONLY) scrive su file esterno",
      `sort -o /tmp/adv-sort2 /etc/hostname`,
      async () => `esiste /tmp/adv-sort2 = ${await Bun.file("/tmp/adv-sort2").exists()}`,
      async () => {
        await fs.rm("/tmp/adv-sort2", { force: true })
        console.log("  [arm] /tmp/adv-sort2 rimosso")
      },
    )
  })

  // ---------- openssl: READ_ONLY, scrive con -out ----------
  await phase("OPENSSL", async () => {
    await permanence(
      "openssl (READ_ONLY) -out su path esterno",
      `openssl rand -out /tmp/adv-openssl 16`,
      async () => `esiste /tmp/adv-openssl = ${await Bun.file("/tmp/adv-openssl").exists()}`,
      async () => {
        await fs.rm("/tmp/adv-openssl", { force: true })
        console.log("  [arm] /tmp/adv-openssl rimosso")
      },
    )
  })

  // ---------- ssh-keygen: READ_ONLY, scrive la chiave con -f ----------
  await phase("SSHKEYGEN", async () => {
    await permanence(
      "ssh-keygen (READ_ONLY) -f su path esterno",
      `ssh-keygen -q -t rsa -b 2048 -f /tmp/adv-key -N ""`,
      async () => `esiste /tmp/adv-key = ${await Bun.file("/tmp/adv-key").exists()}`,
      async () => {
        await fs.rm("/tmp/adv-key", { force: true })
        await fs.rm("/tmp/adv-key.pub", { force: true })
        console.log("  [arm] /tmp/adv-key rimosso")
      },
    )
  })

  // ---------- git: READ_ONLY, inizializza un repo FUORI ----------
  await phase("GIT", async () => {
    await permanence(
      "git init (READ_ONLY) su path esterno",
      `git init -q /tmp/adv-gitrepo`,
      async () => `esiste /tmp/adv-gitrepo/.git = ${await Bun.file("/tmp/adv-gitrepo/.git/HEAD").exists()}`,
      async () => {
        await fs.rm("/tmp/adv-gitrepo", { recursive: true, force: true })
        console.log("  [arm] /tmp/adv-gitrepo rimosso")
      },
    )
  })

  // ---------- git clone / config --global ----------
  await phase("GITCFG", async () => {
    const r = await run(`git config --global adv2.marker x`, "git config --global (scrive in $HOME)")
    console.log(`  --> ${fmt(r.records)}`)
    const r2 = await run(`git config --global adv2.marker y`, "git config --global idem 2a volta", false)
    console.log(`  --> 2a volta: ${fmt(r2.records)}`)
  })

  // ---------- H: comando esatto che CONTIENE un jolly di shell ----------
  await phase("WILD", async () => {
    const r = await run("ls *.txt", "H1 comando esatto contenente un jolly di shell")
    console.log(`  --> ${fmt(r.records)}`)
    const r2 = await run("ls *.txt", "H2 idem, 2a volta (il 'sempre' ha effetto?)", false)
    console.log(`  --> 2a volta: ${fmt(r2.records)}`)
  })

  // ---------- I: secondo statement di un compound, dopo il click sul compound ----------
  await phase("COMPOUND", async () => {
    await fs.writeFile(ROOT + "/COMPOUND/program/vittima.txt", "v\n")
    await run("ls -la; rm -f " + ROOT + "/COMPOUND/program/vittima.txt", "I1 compound con rm INTERNO al progetto")
    console.log(
      "  probe 'rm -f .../vittima.txt' standalone (2o statement concesso?):",
      await (async () => {
        const id = "per_p_" + ++pc
        let st = "allow"
        const p = PermissionNext.ask({ id, sessionID, permission: "bash", patterns: [`rm -f ${ROOT}/COMPOUND/program/vittima.txt`], always: [], metadata: {}, ruleset } as any).then(
          () => (st = "allow"),
          (e: any) => (st = "DENIED"),
        )
        await sleep(30)
        const pend = (await PermissionNext.list()).find((x) => x.id === id)
        if (pend) await PermissionNext.reply({ requestID: id, reply: "reject" })
        await p
        return pend ? "ask" : st
      })(),
    )
    await fs.writeFile(ROOT + "/COMPOUND/program/vittima2.txt", "v\n")
    const r2 = await run("ls -la; rm -f " + ROOT + "/COMPOUND/program/vittima2.txt", "I2 compound IDENTICO con 2a vittima", false)
    console.log(`  --> richieste: ${fmt(r2.records)}`)
    console.log("  vittima2 cancellata (2a esecuzione silenziosa):", !(await Bun.file(ROOT + "/COMPOUND/program/vittima2.txt").exists()))
  })

  await Instance.disposeAll().catch(() => {})
  console.log("\n\n########## FINE PROBE 2 ##########")
}

Log.init({ print: false, level: "ERROR" } as any).catch(() => {})
await main()