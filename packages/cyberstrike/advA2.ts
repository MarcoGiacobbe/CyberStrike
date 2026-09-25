// ATTAQUE A2/B2/B3/P6 — dove va a finire la SCRITTURA, e canonical vs kernel.
import fs from "fs"
import os from "os"
import path from "path"

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "advA2-"))
process.env["CYBERSTRIKE_HOME"] = path.join(BASE, "root")
process.env["XDG_DATA_HOME"] = path.join(BASE, "xdg", "data")
process.env["XDG_CACHE_HOME"] = path.join(BASE, "xdg", "cache")
process.env["XDG_CONFIG_HOME"] = path.join(BASE, "xdg", "config")
process.env["XDG_STATE_HOME"] = path.join(BASE, "xdg", "state")
fs.mkdirSync(path.join(BASE, "root", "bugbounty", "programs"), { recursive: true })
const { BountyState } = await import("./src/session/bounty-state")
const PROG = BountyState.programsDir()
function rec(caso: string, input: string, output: string | Error) {
  console.log(`[${caso}]\n  input : ${input}\n  output: ${output instanceof Error ? `${output.constructor.name}: ${output.message}` : output}`)
}

// ---- A2-follow: state nella dir reale che dichiara il LINK; il link sparisce; refresh() ----
{
  const reale = path.join(PROG, "a2r")
  fs.mkdirSync(reale, { recursive: true })
  const link = path.join(PROG, "a2link")
  fs.symlinkSync(reale, link)
  const declared = link
  fs.writeFileSync(path.join(reale, "state.json"), JSON.stringify({ ...BountyState.create({ directory: declared, program: "a2r" }), phase: "testing" }))
  let readOk = "n/d"
  try {
    readOk = `ACCEPT, Info.directory=${BountyState.read(reale).directory}`
  } catch (e) {
    readOk = (e as Error).message
  }
  rec("A2a read(reale) con dichiarazione = link", `dichiara ${declared}`, readOk)
  // ora il link scompare (rm del symlink) e si chiama refresh sulla dir REALE
  fs.rmSync(link)
  try {
    const r = BountyState.refresh(reale, "a2r")
    rec("A2b refresh(reale) DOPO la sparizione del link", `link rimosso; Info.directory=`, `${r.directory}`)
  } catch (e) {
    rec("A2b refresh(reale) DOPO la sparizione del link", "link rimosso", e as Error)
  }
  rec(
    "A2c effetto su disco",
    `reale=${reale}`,
    `reale/state.json esiste=${fs.existsSync(path.join(reale, "state.json"))}; ` +
      `link ora e' ${fs.existsSync(link) ? (fs.lstatSync(link).isDirectory() ? "UNA DIRECTORY creata da write()" : "altro") : "assente"}; ` +
      `reale/a2link? esiste=${fs.existsSync(path.join(reale, "a2link"))}; ` +
      `reale/a2link/state.json esiste=${fs.existsSync(path.join(reale, "a2link", "state.json"))}`,
  )
}

// ---- B2-follow: dichiarazione RELATIVA "." — dove scrive refresh()? ----
{
  const proj = path.join(PROG, "b2p")
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, "state.json"), JSON.stringify({ ...BountyState.create({ directory: ".", program: "b2p" }), phase: "testing" }))
  const altrove = path.join(BASE, "cwd-altrove")
  fs.mkdirSync(altrove, { recursive: true })
  // cwd = altrove, ma lo state dichiara "." -> canonical(".") = altrove != proj -> rifiutato
  process.chdir(altrove)
  let esito1 = "n/d"
  try {
    esito1 = `ACCEPT directory=${BountyState.read(proj).directory}`
  } catch (e) {
    esito1 = (e as Error).message
  }
  rec("B2a state con directory='.' letto con cwd ALTROVE", `cwd=${altrove} proj=${proj} dichiara "."`, esito1)
  // cwd = proj -> accettato
  process.chdir(proj)
  let esito2 = "n/d"
  try {
    esito2 = `ACCEPT directory=${BountyState.read(proj).directory}`
  } catch (e) {
    esito2 = (e as Error).message
  }
  rec("B2b state con directory='.' letto con cwd = LA DIR", `cwd=${proj}`, esito2)
  // e ora refresh con cwd = proj: dove scrive?
  const altrove2 = path.join(BASE, "cwd-altrove2")
  fs.mkdirSync(altrove2, { recursive: true })
  try {
    const r = BountyState.refresh(proj, "b2p")
    rec("B2c refresh(proj) con cwd = proj", `directory restituita=${r.directory}`, "OK")
  } catch (e) {
    rec("B2c refresh(proj) con cwd = proj", "n/d", e as Error)
  }
  rec(
    "B2d dove e' finito lo state.json",
    `proj=${proj} cwd=${process.cwd()}`,
    `proj/state.json esiste=${fs.existsSync(path.join(proj, "state.json"))} (dichiara ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(proj, "state.json"), "utf8")).directory)})`,
  )
  // ora cwd = altrove2 e provo a scrivere lo stato con Info.directory="." via refresh su un ALTRO progetto
  process.chdir(altrove2)
  const proj2 = path.join(PROG, "b2p2")
  fs.mkdirSync(proj2, { recursive: true })
  fs.writeFileSync(path.join(proj2, "state.json"), JSON.stringify({ ...BountyState.create({ directory: ".", program: "b2p2" }) }))
  // leggo proj2 con cwd=proj2 per far passare il check, poi cambio cwd e chiamo write su quell'Info
  process.chdir(proj2)
  const info = BountyState.read(proj2)
  process.chdir(altrove2)
  let esito3 = "n/d"
  try {
    BountyState.write({ ...info, phase: "paused" })
    esito3 = `write() completato`
  } catch (e) {
    esito3 = (e as Error).message
  }
  rec("B2e write(Info con directory='.') eseguito con cwd ALTROVE", `Info.directory="."; cwd=${altrove2}`, esito3)
  rec(
    "B2f file scritti fuori dal progetto",
    `altrove2=${altrove2}`,
    `altrove2/state.json esiste=${fs.existsSync(path.join(altrove2, "state.json"))}` +
      (fs.existsSync(path.join(altrove2, "state.json")) ? ` contenuto.directory=${JSON.stringify(JSON.parse(fs.readFileSync(path.join(altrove2, "state.json"), "utf8")).directory)}` : "") +
      `; proj2/state.json.phase=${JSON.parse(fs.readFileSync(path.join(proj2, "state.json"), "utf8")).phase}`,
  )
  process.chdir(BASE)
}

// ---- B3/P6: symlink + ".." — canonical collassa lessicalmente, il kernel no ----
{
  const prog = path.join(PROG, "p6-attaccante")
  fs.mkdirSync(prog, { recursive: true })
  const vittima = path.join(BASE, "vittima-p6", "sub")
  fs.mkdirSync(vittima, { recursive: true })
  fs.writeFileSync(path.join(BASE, "vittima-p6", "dato-utente.txt"), "roba mia")
  const s = path.join(prog, "s")
  fs.symlinkSync(path.join(BASE, "vittima-p6", "sub"), s) // s -> vittima/sub
  const dirString = path.join(prog, "s", "..") // kernel: vittima-p6/ ; resolve: prog
  rec(
    "P6a canonical vs kernel per un path con symlink + '..'",
    `dir = ${dirString}`,
    `BountyState.canonical(dir)      = ${BountyState.canonical(dirString)}\n` +
      `          fs.realpathSync(dir)  = ${fs.realpathSync(dirString)}   <-- dir REALE del kernel\n` +
      `          path.resolve(dir)     = ${path.resolve(dirString)}\n` +
      `          uguali? canonical == realpathSync: ${BountyState.canonical(dirString) === fs.realpathSync(dirString)}`,
  )
  rec("P6b isHuntingDir su quel path", `dir = ${dirString}`, `${BountyState.isHuntingDir(dirString)}  (kernel-wise la dir e' ${fs.realpathSync(dirString)})`)
  let esito = "n/d"
  try {
    const r = BountyState.refresh(dirString, "p6")
    esito = `refresh OK, Info.directory=${r.directory}`
  } catch (e) {
    esito = (e as Error).message
  }
  rec("P6c refresh(path con symlink+'..')", `dir = ${dirString}`, esito)
  rec(
    "P6d la prova che conta: state.json nella VITTIMA fuori dalla base?",
    `vittima = ${path.join(BASE, "vittima-p6")}`,
    `vittima/state.json esiste = ${fs.existsSync(path.join(BASE, "vittima-p6", "state.json"))}` +
      (fs.existsSync(path.join(BASE, "vittima-p6", "state.json"))
        ? ` (dichiara ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(BASE, "vittima-p6", "state.json"), "utf8")).directory)}, program=${JSON.parse(fs.readFileSync(path.join(BASE, "vittima-p6", "state.json"), "utf8")).program})`
        : ""),
  )
  // e in piu': lo stesso path puo' essere letto come progetto?
  rec(
    "P6e read(path con symlink+'..')",
    `dir = ${dirString}`,
    (() => {
      try {
        return `ACCEPT program=${BountyState.read(dirString).program}`
      } catch (e) {
        return (e as Error).message
      }
    })(),
  )
}

// ---- P6-follow: symlink dentro programs/ verso una dir esterna che HA uno stato valido ----
{
  const fuori = path.join(BASE, "vittima-con-stato")
  fs.mkdirSync(fuori, { recursive: true })
  fs.writeFileSync(path.join(fuori, "state.json"), JSON.stringify(BountyState.create({ directory: fuori, program: "vittima" })))
  const link = path.join(PROG, "p6-link")
  fs.symlinkSync(fuori, link)
  rec("P6f isHuntingDir(symlink dentro programs/ -> dir esterna CON stato valido)", link, `${BountyState.isHuntingDir(link)}`)
  let esito = "n/d"
  try {
    esito = `refresh OK, program=${BountyState.refresh(link).program}`
  } catch (e) {
    esito = (e as Error).message
  }
  rec("P6g refresh su quel link", link, esito)
}

console.log(`\nBASE=${BASE}`)
console.log(`PROG=${PROG}`)