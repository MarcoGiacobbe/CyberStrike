// ATTAQUE E — regressione operativa su un progetto REALE della macchina.
// Legge ~/.cyberstrike/bugbounty/programs/* e il DB reale (~/.local/share/cyberstrike/cyberstrike.db).
import fs from "fs"
import os from "os"
import path from "path"

const { BountyState } = await import("./src/session/bounty-state")
const { Instance } = await import("./src/project/instance")

function rec(caso: string, input: string, output: string) {
  console.log(`[${caso}]\n  input : ${input}\n  output: ${output}`)
}
function t(fn: () => unknown) {
  try {
    return `OK -> ${fn()}`
  } catch (e) {
    return `${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 200)}`
  }
}

rec("E0 root()/programsDir() reali", "nessun CYBERSTRIKE_HOME impostato in questo processo", `root()=${BountyState.root()}\n          programsDir()=${BountyState.programsDir()}\n          cwd=${process.cwd()}`)

// il progetto reale sulla macchina
const reali = fs.existsSync(BountyState.programsDir()) ? fs.readdirSync(BountyState.programsDir()) : []
rec("E1 progetti reali sotto ~/.cyberstrike/bugbounty/programs/", BountyState.programsDir(), JSON.stringify(reali) + ` (${reali.length})`)
for (const name of reali) {
  const d = path.join(BountyState.programsDir(), name)
  const hasState = fs.existsSync(path.join(d, "state.json"))
  rec(
    `E2 progetto reale "${name}"`,
    `d=${d} state.json presente=${hasState}`,
    [
      `isHuntingDir=${t(() => BountyState.isHuntingDir(d))}`,
      `read()=${t(() => BountyState.read(d).program)}`,
      `exists()=${t(() => BountyState.exists(d))}`,
      `derive()=${t(() => JSON.stringify(BountyState.derive(d)))}`,
      // spelling varianti che il web UI / HTTP puo' produrre
      `isHuntingDir(slash finale)=${t(() => BountyState.isHuntingDir(d + "/"))}`,
    ].join("\n          "),
  )
}

// E3: il DB reale — quali directory usano le sessioni dei progetti bounty?
const { Database } = await import("./src/storage/db")
const { SessionTable } = await import("./src/session/session.sql")
const sess = Instance !== undefined ? Database.use((db) => db.select({ id: SessionTable.id, directory: SessionTable.directory }).from(SessionTable).all()) : []
rec("E3 session table del DB reale", `righe=${sess.length}`, sess.map((r) => `${r.id}  ${r.directory}`).join("\n          "))
const progs = sess.filter((r) => r.directory.includes("/bugbounty/programs/"))
rec(
  "E4 sessioni il cui directory e' sotto bugbounty/programs/",
  "filtro: directory.includes('/bugbounty/programs/')",
  progs.length === 0
    ? "NESSUNA -> su questa macchina nessuna sessione punta a un progetto bounty: la regressione P9 non e' osservabile su dati reali (la feature non ha ancora dati di produzione)"
    : progs
        .map((r) => {
          const esiste = fs.existsSync(r.directory)
          const link = (() => {
            try {
              return fs.realpathSync(r.directory) !== path.resolve(r.directory)
            } catch {
              return false
            }
          })()
          const canon = BountyState.canonical(r.directory)
          const canonTarget = BountyState.canonical(BountyState.programsDir())
          return `${r.directory}: esiste=${esiste} symlink=${link} canonical=${canon} dentroLaBase=${canon.startsWith(canonTarget + "/")}`
        })
        .join("\n          "),
)
// E5: le UNICHE directory realmente usate dal DB come "directory" di progetto note
const uniq = [...new Set(sess.map((r) => r.directory))]
rec(
  "E5 canonical vs spelling delle directory del DB reale",
  `${uniq.length} directory distinte`,
  uniq
    .map((d) => {
      const canon = BountyState.canonical(d)
      let esiste = "no"
      try {
        esiste = fs.realpathSync(d) ? "si" : "no"
      } catch {
        esiste = "no (realpath fallisce -> fallback resolve)"
      }
      return `${d}\n            canonical=${canon}  ugualeAOra=${canon === path.resolve(d)}  esiste=${esiste}`
    })
    .join("\n          "),
)
console.log(`\nDB usato = ${path.join(process.env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local/share"), "cyberstrike", "cyberstrike.db")}`)
console.log(`HOME=${os.homedir()}`)