// ATTAQUE A/B/C — canonical(), identita' dello stato, isHuntingDir.
// Script temporaneo (verrà rimosso). Non modifica src/.
import fs from "fs"
import os from "os"
import path from "path"

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "advABC-"))
process.env["CYBERSTRIKE_HOME"] = path.join(BASE, "root")
process.env["XDG_DATA_HOME"] = path.join(BASE, "xdg", "data")
process.env["XDG_CACHE_HOME"] = path.join(BASE, "xdg", "cache")
process.env["XDG_CONFIG_HOME"] = path.join(BASE, "xdg", "config")
process.env["XDG_STATE_HOME"] = path.join(BASE, "xdg", "state")
fs.mkdirSync(path.join(BASE, "root", "bugbounty", "programs"), { recursive: true })

const { BountyState } = await import("./src/session/bounty-state")

const out: { caso: string; input: string; output: string }[] = []
function rec(caso: string, input: string, output: string | Error) {
  out.push({ caso, input, output: output instanceof Error ? `${output.constructor.name}: ${output.message}` : output })
}
function tryRead(label: string, dir: string, input: string) {
  try {
    const info = BountyState.read(dir)
    rec(label, input, `ACCEPT program=${info.program} directory=${info.directory}`)
  } catch (e) {
    rec(label, input, (e as Error))
  }
}
function stateJson(dir: string, declared: string, over: Record<string, unknown> = {}) {
  return JSON.stringify(
    { ...BountyState.create({ directory: declared, program: path.basename(dir) }), ...over },
    null,
    2,
  )
}

const PROG = BountyState.programsDir()

// ---------- A ----------
// A1: dir reale + symlink; state.json nella dir REALE dichiara il path REALE; si legge dal LINK.
{
  const reale = path.join(PROG, "a1-reale")
  fs.mkdirSync(reale, { recursive: true })
  const link = path.join(PROG, "a1-link")
  fs.symlinkSync(reale, link)
  fs.writeFileSync(path.join(reale, "state.json"), stateJson(reale, reale, { phase: "testing" }))
  tryRead("A1 read(link) su state che dichiara il path REALE", link, `link=${link} -> reale=${reale}`)
}
// A2: state.json nella dir reale dichiara il path del LINK; si legge dalla dir REALE.
{
  const reale = path.join(PROG, "a2-reale")
  fs.mkdirSync(reale, { recursive: true })
  const link = path.join(PROG, "a2-link")
  fs.symlinkSync(reale, link)
  fs.writeFileSync(path.join(reale, "state.json"), stateJson(reale, link, { phase: "testing" }))
  tryRead("A2 read(reale) su state che dichiara il LINK", reale, `directory dichiarata=${link}, letta in ${reale}`)
}
// A3: il link viene rimosso: la dichiarazione (che era il link) non canonicalizza piu' uguale.
{
  const reale = path.join(PROG, "a3-reale")
  fs.mkdirSync(reale, { recursive: true })
  const link = path.join(PROG, "a3-link")
  fs.symlinkSync(reale, link)
  fs.writeFileSync(path.join(reale, "state.json"), stateJson(reale, link))
  fs.rmSync(link)
  tryRead("A3 link a3-link rimosso, si legge dalla dir reale", reale, `dichiara ${link} (link ora inesistente)`)
}

// ---------- B ----------
// B1: spelling alternativi della STESSA dir nella dichiarazione.
{
  const p = path.join(PROG, "b1")
  fs.mkdirSync(p, { recursive: true })
  const variants: [string, string][] = [
    ["trailing slash", p + "/"],
    ["slash doppi", p.replace("/programs/", "//programs//")],
    ["segmento .", path.join(p, ".")],
    [".. che rientra", path.join(PROG, "b1", "..", "b1")],
    [".. + nome inesistente", path.join(PROG, "b1", "nonesiste", "..")],
  ]
  for (const [label, declared] of variants) {
    fs.writeFileSync(path.join(p, "state.json"), stateJson(p, declared))
    tryRead(`B1 dichiara "${label}" e si legge in ${p}`, p, `directory dichiarata = ${JSON.stringify(declared)}`)
  }
}
// B2: dichiarazione RELATIVA (".", "") — canonical risolve contro process.cwd().
{
  const p = path.join(PROG, "b2")
  fs.mkdirSync(p, { recursive: true })
  for (const [label, declared] of [["punto .", "."], ["stringa vuota", ""], ["relativo ./", "./"]] as [string, string][]) {
    fs.writeFileSync(path.join(p, "state.json"), stateJson(p, declared))
    process.chdir(p)
    tryRead(`B2 cwd=${p}, dichiara ${label}`, p, `directory dichiarata = ${JSON.stringify(declared)}`)
    process.chdir(BASE)
  }
}
// B2b: stesso state con dichiarazione relativa letto da UN'ALTRA directory (cwd = quella).
{
  const p = path.join(PROG, "b2b")
  const altro = path.join(PROG, "b2b-altro")
  fs.mkdirSync(p, { recursive: true })
  fs.mkdirSync(altro, { recursive: true })
  fs.writeFileSync(path.join(p, "state.json"), stateJson(p, ".", { program: "acme" }))
  process.chdir(altro)
  tryRead(`B2b state in ${p} dichiara "." e si legge in ${altro} (cwd=${altro})`, altro, `directory dichiarata = "."`)
  process.chdir(BASE)
}
// B3: dichiarazione con symlink + ".." — path.resolve collassa LESSICALMENTE, il kernel no.
{
  const p = path.join(PROG, "b3")
  fs.mkdirSync(p, { recursive: true })
  const escape = path.join(BASE, "escape-b3", "deep")
  fs.mkdirSync(escape, { recursive: true })
  const s = path.join(p, "s")
  fs.symlinkSync(escape, s)
  const declared = path.join(p, "s", "..")
  fs.writeFileSync(path.join(p, "state.json"), stateJson(p, declared, { phase: "testing" }))
  tryRead(`B3 dichiara ${declared} (s -> ${escape})`, p, `s -> ${escape}; dichiarata = ${declared}`)
  // ora la parte che conta: dove scrive refresh()/write()?
  try {
    const r = BountyState.refresh(p, "b3")
    rec("B3b refresh() su quello stato", `directory dichiarata = ${declared}`, `OK -> directory dell'Info scritto = ${r.directory}`)
  } catch (e) {
    rec("B3b refresh() su quello stato", `directory dichiarata = ${declared}`, e as Error)
  }
  rec(
    "B3c dove e' finito davvero lo state.json?",
    `path.resolve(declared)=${path.resolve(declared)}`,
    `escape/state.json esiste=${fs.existsSync(path.join(BASE, "escape-b3", "state.json"))}; ` +
      `dir-progetto/state.json mtime=${fs.statSync(path.join(p, "state.json")).mtimeMs}; ` +
      `contenuto escape=${fs.existsSync(path.join(BASE, "escape-b3", "state.json")) ? JSON.parse(fs.readFileSync(path.join(BASE, "escape-b3", "state.json"), "utf8")).directory : "n/d"}`,
  )
}
// B4: la stessa tecnica puntata a un PROGRAMMA SORELLA dentro la base.
{
  const p = path.join(PROG, "b4-attaccante")
  const vittima = path.join(PROG, "b4-vittima")
  fs.mkdirSync(p, { recursive: true })
  fs.mkdirSync(vittima, { recursive: true })
  fs.writeFileSync(path.join(vittima, "state.json"), stateJson(vittima, vittima, { phase: "paused", program: "b4-vittima" }))
  const s = path.join(p, "l")
  fs.symlinkSync(path.join(PROG, "b4-vittima"), s) // l -> <programs>/b4-vittima
  // "<p>/l/../<...>": kernel = <programs>/<...>  |  resolve = <p>/<...>
  const declared = path.join(p, "l", "..", "b4-vittima")
  fs.writeFileSync(path.join(p, "state.json"), stateJson(p, declared, { program: "b4-attaccante" }))
  process.chdir(p)
  tryRead(`B4 dichiara ${declared}`, p, `l -> ${vittima}; dichiarata=${declared}; resolve=${path.resolve(declared)}`)
  process.chdir(BASE)
}

// ---------- C ----------
{
  const casi: [string, string, () => string][] = []
  // C1: symlink dentro programs/ verso un ALTRO programma dentro la base
  const realC = path.join(PROG, "c1-vero")
  fs.mkdirSync(realC, { recursive: true })
  const linkC = path.join(PROG, "c1-link")
  fs.symlinkSync(realC, linkC)
  casi.push([
    "C1 symlink dentro programs/ -> altro programma DENTRO la base",
    linkC,
    () => `${BountyState.isHuntingDir(linkC)} (canonical(link)=${path.join(PROG, "c1-vero")}, rel=1 segmento)`,
  ])
  // C2: figlio che e' un FILE (non dir)
  const fileC = path.join(PROG, "c2-file")
  fs.writeFileSync(fileC, "non sono una directory")
  casi.push(["C2 figlio che e' un FILE", fileC, () => `${BountyState.isHuntingDir(fileC)}`])
  // C3: figlio FILE che CONTIENE uno state.json valido? (impossibile: e' un file)
  // C3: figlio con slash finale
  const dirC = path.join(PROG, "c3-dir")
  fs.mkdirSync(dirC, { recursive: true })
  casi.push(["C3 figlio con slash finale", dirC + "/", () => `${BountyState.isHuntingDir(dirC + "/")}`])
  // C4: nome vuoto / solo spazi
  {
    const vuoto = path.join(PROG, "")
    fs.mkdirSync(vuoto, { recursive: true })
    casi.push(["C4 'nome vuoto' (= programs/ stessa)", JSON.stringify(vuoto), () => `${BountyState.isHuntingDir(vuoto)}`])
    const spazi = path.join(PROG, "  ")
    fs.mkdirSync(spazi, { recursive: true })
    casi.push(["C5 nome con soli spazi", JSON.stringify(spazi), () => `${BountyState.isHuntingDir(spazi)}`])
  }
  // C6: symlink NEL MEZZO del path (base raggiunta attraverso un link)
  {
    const baseLink = path.join(BASE, "base-link")
    fs.symlinkSync(path.join(BASE, "root", "bugbounty", "programs"), baseLink)
    const viaLink = path.join(baseLink, "c6")
    fs.mkdirSync(viaLink, { recursive: true })
    casi.push([
      "C6 progetto creato/reale, raggiunto via symlink intermedio",
      viaLink,
      () => `${BountyState.isHuntingDir(viaLink)} (esiste via link: ${fs.existsSync(viaLink)})`,
    ])
  }
  // C7: progetto valido SPOSTATO fuori dal layout, con la dichiarazione VECCHIA
  {
    const vecchia = path.join(PROG, "c7")
    fs.mkdirSync(vecchia, { recursive: true })
    fs.writeFileSync(path.join(vecchia, "state.json"), stateJson(vecchia, vecchia, { phase: "testing" }))
    const spostato = path.join(BASE, "c7-spostato")
    fs.renameSync(vecchia, spostato)
    casi.push([
      "C7 progetto con stato VALIDO spostato FUORI dal layout (dichiara il path vecchio)",
      spostato,
      () => `${BountyState.isHuntingDir(spostato)} (exists=${BountyState.exists(spostato)})`,
    ])
  }
  // C8: progetto fuori dal layout con stato valido e dichiarazione aggiornata
  {
    const fuori = path.join(BASE, "c8-fuori")
    fs.mkdirSync(fuori, { recursive: true })
    fs.writeFileSync(path.join(fuori, "state.json"), stateJson(fuori, fuori))
    casi.push(["C8 progetto fuori dal layout, dichiarazione corretta", fuori, () => `${BountyState.isHuntingDir(fuori)}`])
  }
  // C9: sottodirectory di un progetto dentro il layout (2 segmenti)
  {
    const sotto = path.join(PROG, "c9", "scans")
    fs.mkdirSync(sotto, { recursive: true })
    casi.push(["C9 sottodirectory <programma>/scans", sotto, () => `${BountyState.isHuntingDir(sotto)}`])
  }
  for (const [caso, input, fn] of casi) {
    try {
      rec(caso, input, fn())
    } catch (e) {
      rec(caso, input, e as Error)
    }
  }
}

for (const o of out) console.log(`[${o.caso}]\n  input : ${o.input}\n  output: ${o.output}`)
console.log(`\nBASE=${BASE}`)
console.log(`PROG=${PROG}`)