// ATTAQUE E/B4b — regressione operativa + scrittura nel progetto SOSRELLA.
import fs from "fs"
import os from "os"
import path from "path"

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "advG-"))
process.env["CYBERSTRIKE_HOME"] = path.join(BASE, "root")
process.env["XDG_DATA_HOME"] = path.join(BASE, "xdg", "data")
process.env["XDG_CACHE_HOME"] = path.join(BASE, "xdg", "cache")
process.env["XDG_CONFIG_HOME"] = path.join(BASE, "xdg", "config")
process.env["XDG_STATE_HOME"] = path.join(BASE, "xdg", "state")
fs.mkdirSync(path.join(BASE, "root", "bugbounty", "programs"), { recursive: true })
const { BountyState } = await import("./src/session/bounty-state")
const PROG = BountyState.programsDir()
function rec(caso: string, input: string, output: string | Error) {
  console.log(`[${caso}]\n  input : ${input}\n  output: ${output instanceof Error ? `${output.constructor.name}: ${output.message.slice(0, 200)}` : output}`)
}
const t = (fn: () => unknown) => {
  try {
    return `OK -> ${fn()}`
  } catch (e) {
    return `${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 160)}`
  }
}

// ---- E-regressione: stesso state.json letto con gli spelling che HTTP/GUI possono mandare ----
{
  const p = path.join(PROG, "reg")
  fs.mkdirSync(p, { recursive: true })
  const info = BountyState.create({ directory: p, program: "reg" })
  BountyState.write(info) // scrittura "canonica", come farebbe la prima sessione
  const link = path.join(BASE, "alias-del-progetto")
  fs.symlinkSync(p, link)
  const spelling: [string, string][] = [
    ["canonico", p],
    ["slash finale", p + "/"],
    ["slash doppio", p.replace("/programs/", "//programs//")],
    ["spelling con `..`", path.join(PROG, "reg", "..", "reg")],
    ["segmento `.`", path.join(p, ".")],
    ["via symlink esterno", link],
    ["via symlink + slash finale", link + "/"],
    ["relativo (cwd=dir)", "."],
  ]
  for (const [label, d] of spelling) {
    const cwd = process.cwd()
    if (d === ".") process.chdir(p)
    const sid = `read(${JSON.stringify(d)}) con cwd=${process.cwd()}`
    rec(`E-regressione: state scritto in modo canonico, riletto come "${label}"`, sid, t(() => `ACCEPT program=${BountyState.read(d).program}`))
    if (d === ".") process.chdir(cwd)
  }
  // il caso inverso: la PRIMA sessione ha scritto con lo spelling strano, la seconda legge canonico
  for (const [label, d] of spelling.slice(0, 8)) {
    const cwd = process.cwd()
    if (d === ".") process.chdir(p)
    BountyState.write(BountyState.create({ directory: d, program: "reg" })) // come farebbe refresh(dir) con quel dir
    rec(
      `E-regressione INVERSO: prima sessione dichiara "${label}", una seconda legge il canonico`,
      `declared=${JSON.stringify(d)}; poi read(${p})`,
      t(() => `ACCEPT program=${BountyState.read(p).program}`),
    )
    if (d === ".") process.chdir(cwd)
  }
}

// ---- B4b: scrittura nello state.json del progetto SOSRELLA (cross-project write) ----
{
  const sorella = path.join(PROG, "sorella")
  fs.mkdirSync(sorella, { recursive: true })
  BountyState.write({ ...BountyState.create({ directory: sorella, program: "sorella" }), phase: "paused" })
  const prima = fs.readFileSync(path.join(sorella, "state.json"), "utf8")
  const att = path.join(PROG, "attaccante")
  fs.mkdirSync(att, { recursive: true })
  const l = path.join(att, "l")
  fs.symlinkSync(sorella, l) // l -> programs/sorella
  const dirString = path.join(att, "l", "..") // kernel = <programs>/ ; realpath = att
  // serve un path che il KERNEL risolva a `sorella`: att/l/../sorella = <programs>/sorella
  const dichiarata = path.join(att, "l", "..", "sorella")
  fs.writeFileSync(path.join(att, "state.json"), JSON.stringify({ ...BountyState.create({ directory: dichiarata, program: "attaccante" }), phase: "recon" }))
  rec(
    "B4b il path passato a read()/refresh() e' l'ATTACCANTE ma state.json dichiara la SORELLA",
    `sessione/rete: dir=${att} (Instance.directory); state.json in ${att} dichiara ${dichiarata}`,
    `canonical(dichiarata)=${BountyState.canonical(dichiarata)}  canonical(dir)=${BountyState.canonical(att)}  uguali=${BountyState.canonical(dichiarata) === BountyState.canonical(att)}`,
  )
  rec("B4b2 refresh(att) — dove scrive?", `file(info.directory) = ${BountyState.file(dichiarata)}`, t(() => `OK -> refresh -> program=${BountyState.refresh(att, "attaccante").program}`))
  const dopo = fs.readFileSync(path.join(sorella, "state.json"), "utf8")
  rec(
    "B4b3 lo state.json della SORELLA e' stato riscritto dalla sessione dell'attaccante?",
    `sorella/state.json prima: phase="${JSON.parse(prima).phase}" program="${JSON.parse(prima).program}"`,
    `sorella/state.json dopo : phase="${JSON.parse(dopo).phase}" program="${JSON.parse(dopo).program}" updatedAt cambiato=${JSON.parse(prima).updatedAt !== JSON.parse(dopo).updatedAt}  -> ${prima !== dopo ? "RISCRITTO" : "intatto"}`,
  )
  rec(
    "B4b4 e lo state.json dell'attaccante?",
    `${att}/state.json`,
    `esiste=${fs.existsSync(path.join(att, "state.json"))} phase=${JSON.parse(fs.readFileSync(path.join(att, "state.json"), "utf8")).phase}`,
  )
  // e il tool: bounty_status sull'attaccante risponde col programma della sorella
  const { Instance } = await import("./src/project/instance")
  const { BountyStatusTool } = await import("./src/tool/bounty-status")
  await Instance.provide({
    directory: att,
    fn: async () => {
      const r = await (await BountyStatusTool.init()).execute({}, { sessionID: "ses_adv", ask: async () => {} } as never)
      rec("B4b5 bounty_status eseguito con Instance.directory = l'attaccante", `directory=${BountyState.canonical(att)}`, `title="${r.title}"\n          output=${JSON.stringify(r.output.split("\n").slice(0, 3))}\n          metadata.program=${r.metadata?.program} hunting=${r.metadata?.hunting}`)
    },
  })
}

// ---- F4: regenerate() ha un chiamante? (l'unica via per uscire da uno stato bloccato) ----
{
  const out = Bun.spawnSync(["grep", "-rn", "regenerate", path.join(BASE, ".."), "--include=*.ts"])
  rec(
    "F4 regenerate() e' raggiungibile da un comando?",
    "grep -rn regenerate <repo> --include=*.ts | grep -v node_modules",
    (() => {
      const r = Bun.spawnSync(["bash", "-c", `cd ${JSON.stringify(path.resolve("."))} && grep -rn "regenerate" src/ | head`])
      return r.stdout.toString().trim() || "NESSUN chiamante in src/"
    })(),
  )
  // conseguenza: un progetto il cui state e' Refused resta bloccato per sempre
  const p = path.join(PROG, "brick")
  fs.mkdirSync(p, { recursive: true })
  const finto = path.join(PROG, "brick-vecchio-non-esiste")
  fs.writeFileSync(path.join(p, "state.json"), JSON.stringify(BountyState.create({ directory: finto, program: "brick" })))
  rec(
    "F4b progetto BRICKED: lo stato rifiuta la dir, ma il gate resta armato",
    `${p} (figlio diretto della base) con state.json che dichiara una dir inesistente`,
    `isHuntingDir=${BountyState.isHuntingDir(p)}  (gate todowrite ARMATO, perche' e' un figlio del layout)\n` +
      `          bounty_status=${t(() => BountyState.read(p).program)}  (lancia SEMPRE)\n` +
      `          regenerate() esiste ma nessun comando lo chiama -> unica uscita: cancellare state.json a mano`,
  )
}

console.log(`\nBASE=${BASE}\nPROG=${PROG}`)