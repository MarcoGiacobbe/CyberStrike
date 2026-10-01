import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Il caso che l'utente ha segnalato: `bb hunt` su un programma inesistente
 * deve fermarsi, e NON arrivare al TUI.
 *
 * Perche' non basta un test sul modulo. Il difetto che e' stato misurato NON
 * era nella classificazione dell'errore — che era giusta — ma nella CONDIZIONE
 * con cui veniva usata: `isProgramMissing(e) && unsynced`. Con un programma
 * in locale la seconda parte e' false e l'avvio proseguiva. Un test sulle
 * funzioni pure sarebbe restato verde per tutta la fase, mentre il difetto
 * vero — un TUI da 800 MB lanciato su scope fantasma — era vivo.
 *
 * Quindi qui si misura l'uscita e il tempo, non una stringa interna:
 *  - un programma inesistente: exit 1, NESSUN TUI, e in poco tempo;
 *  - rete assente: exit 0 e l'avviso di fallback, perche' e' il comportamento
 *    approvato nella Fase 2 e questo test non deve permettere che il primo
 *    caso lo cancelli.
 */

const CWD = process.cwd()

function homeWith(program: string, ageDays = 30): string {
  const home = mkdtempSync(path.join(tmpdir(), "bbmanc-"))
  mkdirSync(path.join(home, "bugbounty"), { recursive: true })
  const d = new Date(Date.now() - ageDays * 86_400_000).toISOString()
  writeFileSync(
    path.join(home, "bugbounty", `${program}.json`),
    JSON.stringify({
      name: program,
      platform: "hackerone",
      scope: { in: ["fantasma.example"], out: [] },
      payouts: { low: "$1" },
      lastUpdated: d,
    }),
  )
  return home
}

function runBb(home: string, args: string[], env: Record<string, string> = {}) {
  const t0 = Date.now()
  const r = Bun.spawnSync(["bun", "run", "--conditions=browser", "src/index.ts", "bb", "hunt", ...args], {
    cwd: CWD,
    env: { ...process.env, CYBERSTRIKE_HOME: home, ...env },
    timeout: 90_000,
  })
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
    ms: Date.now() - t0,
  }
}

const homes: string[] = []
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

describe("bb hunt: programma inesistente si ferma, non arriva al TUI", () => {
  test("programma inesistente: exit 1, messaggio chiaro, nessun TUI", () => {
    const home = homeWith("non_esiste_questo")
    homes.push(home)
    const r = runBb(home, ["non_esiste_questo"])

    expect(r.code).toBe(1)
    expect(r.out).toContain("non esiste su HackerOne")
    // il TUI non deve mai essere lanciato: e' un processo da ~800MB e senza
    // terminale non esce mai da solo.
    expect(r.out).not.toContain("--session")
    // e la promessa "niente scritto" deve essere vera
    const dir = path.join(home, "bugbounty", "programs", "non_esiste_questo")
    if (existsSync(dir)) {
      // la directory puo' esistere, ma non deve contenere stato ne' documenti
      expect(readdirSync(dir)).toEqual([])
    }
  }, 120_000)

  test("non ci mette minuti: prima ne servivano 200+ e lanciava il TUI", () => {
    const home = homeWith("altro_inesistente")
    homes.push(home)
    const r = runBb(home, ["altro_inesistente"])
    // 30s di margine sul tempo misurato: il caso puo' fare una richiesta di
    // rete, non un TUI. Serve a distinguere "si e' fermato" da "ha lanciato
    // l'interfaccia e la sta ancora aspettando".
    expect(r.ms).toBeLessThan(30_000)
  }, 120_000)

  test("NON REGRESSIONE: rete assente continua a partire col fallback", () => {
    // Il caso opposto. Se questo test fallisce, il fix del programma
    // inesistente ha mangiato la Fase 2: una rete assente non deve impedire
    // di chiudere il lavoro di ieri.
    const home = homeWith("bcny")
    homes.push(home)
    const r = runBb(home, ["bcny", "--dry-run"], {
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
    })
    expect(r.code).toBe(0)
    expect(r.out).toContain("sincronizzerei bcny")
  }, 120_000)

  test("in --dry-run dichiara che il programma NON e' stato verificato", () => {
    // Il caso scoperto dopo il fix: `--dry-run` non sincronizza, quindi
    // nessun errore arriva e il comando diceva "sincronizzerei ghost" senza
    // avvertire che il nome non e' stato controllato. L'utente che usa il
    // dry-run per ispezionare avrebbe letto un'informazione falsa.
    const home = homeWith("refuso_tipo")
    homes.push(home)
    const r = runBb(home, ["refuso_tipo", "--dry-run"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("NON e' stato verificato")
    // e resta coerente con l'avvio reale, che invece si ferma
    expect(r.out).toContain("Senza --dry-run si ferma")
  }, 120_000)
})
