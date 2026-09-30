import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// TICKET agente-bounty-prompt-iniziale, FASE 1 — la directory del programma.
//
// Il difetto: `bb hunt` passa al TUI la sessione e il messaggio ma NON la
// directory del programma (`bb.ts:791`):
//   const tuiArgs = ["--session", session.id, "--prompt", message, "--agent", args.agent]
// Il TUI fa `process.chdir(args.project ? resolve(...) : process.cwd())`
// (`tui/thread.ts:95`), quindi parte dalla cartella da cui l'utente ha lanciato
// il comando. Tutto cio' che `AGENTS.md` risolve in base a `Instance.directory`
// gira quindi sul posto sbagliato: l'agente riceve le istruzioni del terminale
// da cui e' partito, non quelle del programma.
//
// LA METODOLOGIA, dichiarata perche' questo file non e' banale:
//   Il test non puo' lanciare il TUI vero (richiede un terminale). Quindi
//   asserisce UNA cosa sola e verificabile: che `bb hunt` metta la directory
//   del programma fra gli argomenti che passa al TUI. Lo fa ispezionando il
//   sorgente di `bb.ts` alla riga che costruisce quegli argomenti.
//   Non e' il massimo, ma e' HONESTO: un test che non puo' fallire non
//   misura niente, e questo puo' fallire. Se qualcuno rimuove `--project` da
//   quella riga, questo test diventa rosso.

const REPO = path.resolve(import.meta.dir, "../../../..")
const PKG = path.join(REPO, "packages/cyberstrike")
const BB = path.join(PKG, "src/cli/cmd/bb.ts")
const CLI = path.join(PKG, "src/index.ts")

const HOME = mkdtempSync(path.join(tmpdir(), "bb-hunt-dir-"))
process.env["CYBERSTRIKE_HOME"] = HOME

function seedProgram(handle: string) {
  const root = path.join(HOME, "bugbounty")
  mkdirSync(path.join(root, "programs", handle), { recursive: true })
  writeFileSync(
    path.join(root, `${handle}.json`),
    JSON.stringify({
      name: handle,
      platform: "hackerone",
      programUrl: `https://hackerone.com/${handle}`,
      description: "Programma di prova",
      scope: { in: ["example.com"], out: [] },
      payouts: { high: "$10,000" },
      rules: { maxSteps: 6, authenticated: false, custom: [] },
      lastUpdated: new Date().toISOString(),
    }),
  )
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", "run", "--conditions=browser", CLI, ...args], {
    cwd: PKG,
    env: { ...process.env, CYBERSTRIKE_HOME: HOME },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  return { code, out: out + err }
}

/** La riga (o le righe) che costruiscono gli argomenti del TUI. */
async function tuiArgLines(): Promise<string> {
  const src = await Bun.file(BB).text()
  const idx = src.indexOf("tuiArgs")
  if (idx < 0) return ""
  // Tutto l'array, non una finestra fissa: a 6 righe la finestra si fermava a
  // `--agent` e non arrivava a `--project` — il test era ROSSO col fix gia'
  // applicato, cioe' misurava la mia ipotesi sulla formattazione, non il
  // codice. Le parentesi quadre contengono la risposta.
  const aperta = src.indexOf("[", idx)
  const chiusa = src.indexOf("]", aperta)
  if (aperta < 0 || chiusa < 0) return ""
  return src.slice(aperta, chiusa + 1)
}

describe("fase 1: la directory del programma e' la directory di lavoro", () => {
  test("i tuiArgs includono la directory del programma (--project)", async () => {
    const args = await tuiArgLines()
    // A HEAD questa asserzione e' ROSSA: i tuiArgs sono
    //   ["--session", ..., "--prompt", ..., "--agent", ...]
    // e non c'e' traccia della directory.
    expect(args).toContain("--project")
    // E dev'essere la directory vera, non una stringa vuota o un segnaposto:
    // il flag e il suo valore possono stare su due righe diverse, quindi si
    // cerca il flag e POI la variabile, non i due adiacenti.
    expect(args).toMatch(/"--project"/)
    expect(args).toMatch(/\bdirectory\b|\bdir\b/)
  })

  test("il TUI accetta un argomento di progetto (il flag non e' inventado)", async () => {
    // Se `--project` non esistesse nel TUI, passarlo sarebbe un errore
    // silenzioso: yargs lo terrebbe e basta. Questo test verifica che il
    // TUI lo dichiara davvero, cercandolo dove i comandi definiscono i
    // loro argomenti.
    const tui = await Bun.file(path.join(PKG, "src/cli/cmd/tui/thread.ts")).text()
    expect(tui).toContain("args.project")
  })

  test("la directory creata non contiene la cartella `program` che nessuno leggeva", async () => {
    seedProgram("progclean")
    const { code } = await run(["bb", "hunt", "progclean", "--dry-run"])
    // A HEAD: `fs.mkdirSync(path.join(directory, "program"))` (bb.ts:693) crea
    // una sottocartella `program` che nessun punto di src/ legge. Il dry-run
    // oggi la evita gia', quindi questo test passa anche prima del fix: e' un
    // test di NON REGRESSIONE, non una prova. Dice pero' cosa NON deve
    // ricomparire se un domani qualcuno toglie il vincolo del dry-run.
    const vuota = path.join(HOME, "bugbounty", "programs", "progclean", "program")
    expect(existsSync(vuota)).toBe(false)
    expect(code).toBe(0)
  }, 60_000)

  test("il messaggio all'agente non promette un `program.json` che non esiste", async () => {
    // Non ispeziono il sorgente: lo chiamo. Il testo che l'agente riceve e'
    // l'unica cosa che conta, e misurarlo davvero evita i falsi positivi dei
    // commenti (la regex precedente agganciava l'apostrofo di "e'" nei
    // commenti italiani e faceva fallire il test col fix gia' applicato).
    const { HuntContext } = await import(path.join(PKG, "src/session/hunt-context"))

    const msg = HuntContext.message({
      program: "progmsg",
      directory: "/tmp/progmsg",
      unsynced: true,
    })

    // Fatto misurato il 2026-09-29: a HEAD questo messaggio diceva
    //   "Non c'e' un `program.json`: lo scope e le regole qui sotto non ci sono"
    // `program.json` non e' prodotto da nessuna parte di src/: il file reale
    // e' `<handle>.json` nella root bug bounty, letto a bb.ts:664-671. Il
    // messaggio promiseva un file inesistente e negava dati che invece
    // l'agente aveva sotto gli occhi.
    expect(msg).not.toContain("program.json")
    // E deve comunque dire all'agente cosa fare quando i dati non bastano.
    expect(msg).toMatch(/bb (info|sync) progmsg/)
  })

})

afterAll(() => rmSync(HOME, { recursive: true, force: true }))
