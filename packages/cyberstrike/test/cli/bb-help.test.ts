import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const REPO = path.resolve(import.meta.dir, "../../../..")
// Il CLI va lanciato con cwd = packages/cyberstrike: dalla root del monorepo
// la risoluzione di react fallisce ("Cannot find module
// 'react/jsx-dev-runtime'") perche' gli import partono da src/cli/cmd/tui/app.tsx
// e cercanobbero node_modules di mezzo monoreco piu' in alto. Misurato, non
// ipotizzato.
const PKG = path.join(REPO, "packages/cyberstrike")
const CLI = path.join(PKG, "src/index.ts")

// TICKET help-comandi-bb — ma il difetto reale NON e' "le azioni non sono
// elencate": `bb --help` le elenca gia' tutte e dodici. Il difetto vero e'
// un altro, misurato eseguendo il CLI: `cyberstrike bb` SENZA azione esce
// con codice 1 e STAMPA ZERO BYTE. Chi digita `bb` vede una riga vuota e un
// errore senza spiegazione. Sembra un hang, non un comando che chiede un
// argomento mancante.
//
// Il test asserisce il comportamento osservabile (esce 1, dice qualcosa,
// l'help raggiunge l'utente) e non la stringa esatta: il testo puo' cambiare,
// il silenzio no.

const HOME = mkdtempSync(path.join(tmpdir(), "bb-help-"))
process.env["CYBERSTRIKE_HOME"] = HOME

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  // `--conditions=browser` serve per risolvere react; `cwd` = package perche'
  // dalla root la risoluzione dei moduli fallisce. Entrambi verificati.
  const p = Bun.spawn(["bun", "run", "--conditions=browser", CLI, ...args], {
    cwd: PKG,
    env: { ...process.env, CYBERSTRIKE_HOME: HOME, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  return { code, out: out + err }
}

describe("ticket help-comandi-bb: bb senza azione non tace", () => {
  test("`bb` da solo spiega cosa fare invece di fallire in silenzio", async () => {
    // Locale NON forzato: il difetto si manifesta con it_IT, che e' la lingua
    // del sistema di chi usa il tool. Con LANG=C yargs stampa l'help e il
    // difetto e' invisibile — e' esattamente per questo che il primo test
    // risultava verde e non misurava niente.
    const { code, out } = await run(["bb"])

    expect(out.trim().length).toBeGreaterThan(0)
    expect(out).toMatch(/bb (\S+)|help/i)
  }, 60_000)

  test("lo stesso vale nel locale italiano, dove il difetto e' riprodotto", async () => {
    const { code, out } = await run(["bb"], { LANG: "it_IT.UTF-8", LC_ALL: "it_IT.UTF-8" })
    // Fatti misurati a HEAD: rc=1 con ZERO byte di output.
    expect(out.trim().length).toBeGreaterThan(0)
    expect(out).toMatch(/bb (\S+)|help/i)
  }, 60_000)

  test("`bb --help` elenca le azioni anche nel locale italiano", async () => {
    const { code, out } = await run(["bb", "--help"], { LANG: "it_IT.UTF-8", LC_ALL: "it_IT.UTF-8" })
    expect(code).toBe(0)
    for (const az of ["connect", "disconnect", "whoami", "sync", "list", "info", "add", "remove", "crawl", "hunt"]) {
      expect(out).toContain(`bb ${az}`)
    }
  }, 60_000)
})

afterAll(() => rmSync(HOME, { recursive: true, force: true }))
