// ATTAQUE finale — recuperabilita' (regenerate senza chiamante) e "progetto bricked".
import fs from "fs"
import os from "os"
import path from "path"

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "advH-"))
process.env["CYBERSTRIKE_HOME"] = path.join(BASE, "root")
process.env["XDG_DATA_HOME"] = path.join(BASE, "xdg", "data")
process.env["XDG_CACHE_HOME"] = path.join(BASE, "xdg", "cache")
process.env["XDG_CONFIG_HOME"] = path.join(BASE, "xdg", "config")
process.env["XDG_STATE_HOME"] = path.join(BASE, "xdg", "state")
fs.mkdirSync(path.join(BASE, "root", "bugbounty", "programs"), { recursive: true })
const { BountyState } = await import("./src/session/bounty-state")
const { Instance } = await import("./src/project/instance")
const { BountyStatusTool } = await import("./src/tool/bounty-status")
const PROG = BountyState.programsDir()
const REPO = path.resolve(".")
function rec(caso: string, input: string, output: string) {
  console.log(`[${caso}]\n  input : ${input}\n  output: ${output}`)
}
function sh(cmd: string) {
  const r = Bun.spawnSync(["bash", "-c", cmd])
  return r.stdout.toString().trim() + (r.stderr.toString().trim() ? ` | stderr: ${r.stderr.toString().trim()}` : "")
}

rec(
  "F4 regenerate() e' raggiungibile?",
  `grep -rn "regenerate" ${REPO}/packages/cyberstrike/src`,
  sh(`cd ${JSON.stringify(REPO)} && grep -rn "regenerate" packages/cyberstrike/src | grep -v node_modules`) || "NESSUN chiamante in src/: la funzione esiste e non e' invocata da nessun comando",
)
rec(
  "F4b comandi CLI che parlano di stato bounty",
  `grep -rln "bounty" ${REPO}/packages/cyberstrike/src/cli`,
  sh(`cd ${JSON.stringify(REPO)} && grep -rn "command(\\"" packages/cyberstrike/src/cli/cmd/bb.ts | head -20`),
)

// brick: progetto legittimo RINOMINATO (mv acme acme-2026) — il caso che P9 intende bloccare
{
  const vecchia = path.join(PROG, "acme")
  fs.mkdirSync(vecchia, { recursive: true })
  BountyState.write({ ...BountyState.create({ directory: vecchia, program: "acme" }), phase: "testing" })
  const nuova = path.join(PROG, "acme-2026")
  fs.renameSync(vecchia, nuova)
  rec(
    "F4c progetto RINOMINATO (mv acme acme-2026): la nuova dir e' un progetto?",
    `nuova=${nuova}, state.json dichiara ancora ${vecchia}`,
    `isHuntingDir=${BountyState.isHuntingDir(nuova)}  <- gate todowrite ARMATO\n` +
      `          read() lancia (per progetto, P9 corretto)`,
  )
  await Instance.provide({
    directory: nuova,
    fn: async () => {
      let esito = ""
      try {
        const r = await (await BountyStatusTool.init()).execute({}, { sessionID: "ses_brick", ask: async () => {} } as never)
        esito = `HA RISPOSTO: ${r.title} / hunting=${r.metadata?.hunting}`
      } catch (e) {
        esito = `LANCIA: ${(e as Error).message.slice(0, 120)}`
      }
      rec(
        "F4d bounty_status dentro la dir rinominata (l'unico modo per sbloccare il gate)",
        `Instance.directory=${nuova}`,
        esito +
          `\n          BountyState.loaded("ses_brick")=${BountyState.loaded("ses_brick")} (false: il gate resta chiuso e todowrite resta assente)` +
          `\n          ESITO: non esiste un percorso di recupero via tool: serve cancellare o rigenerare state.json a mano (regenerate() non e' chiamato da nessun comando)`,
      )
    },
  })
  // e qual e' la differenza con un file senza permessi / directory? stesso esito
  const rotta = path.join(PROG, "rotta")
  fs.mkdirSync(rotta, { recursive: true })
  fs.mkdirSync(path.join(rotta, "state.json"))
  rec(
    "F4e caso D2 in contesto operativo: state.json e' una DIRECTORY",
    `${rotta}/state.json (directory)`,
    `isHuntingDir=${BountyState.isHuntingDir(rotta)}; bounty_status lancia Unreadable; unica uscita: rm -rf a mano. ` +
      `regenerate() non lo risolve (scrive/rename su una directory -> EISDIR, verificato)`,
  )
}

// F5: lo stato valido fuori layout con dichiarazione DIVERSA — il gate non si arma ma il messaggio e' fuorviante
{
  const p = fs.mkdtempSync(path.join(BASE, "fuori-"))
  fs.writeFileSync(path.join(p, "state.json"), JSON.stringify(BountyState.create({ directory: path.join(PROG, "altro-progetto"), program: "x" })))
  rec(
    "F5 progetto fuori dal layout con state.json VALIDO ma dichiarante un'ALTRA dir",
    `dir=${p}, dichiara ${path.join(PROG, "altro-progetto")}`,
    `isHuntingDir=${BountyState.isHuntingDir(p)}  (gate NON armato: silenzio)\n` +
      `          read() lancia Unreadable\n` +
      `          bounty_status risponderebbe "This directory is not a bug-bounty project (no state.json ...)" — FALSO: lo state.json c'e' eccome`,
  )
}

console.log(`\nBASE=${BASE}\nPROG=${PROG}`)