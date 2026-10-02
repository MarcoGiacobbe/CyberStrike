/**
 * `run --auto` auto-approva i permessi in `ask`, e i `deny` devono restare
 * `deny`.
 *
 * Contesto (misurato il 2026-10-02): `run` in non-interattivo rispondeva
 * `reply: "reject"` a ogni `permission.asked`. Il primo run reale su `bcny`
 * si e' fermato al secondo tool con exit 1: leggeva `scope.md`, poi
 * `glob (policy.md)` finiva in `ask` e nessuno lo approvava. Non era un
 * blocco di sicurezza, era un canale mancante.
 *
 * `--auto` e' la modalita' che simula un operatore: `ask` -> `always`.
 * Il perimetro NON e' un permesso: i `deny` non arrivano al loop di reply
 * (vanno via DeniedError), quindi `--auto` non puo' toccarli. Ed e'
 * esattamente questo che questi test misurano: se `--auto` potesse
 * aggirare il perimetro, il flag non sarebbe una simulazione di operatore
 * ma un buco.
 *
 * Ogni test che riguarda `--auto` deve FALLIRE a HEAD, perche' a HEAD il
 * flag non esiste e ogni `ask` viene negato. Un test che resta verde a
 * HEAD non sta misurando `--auto`.
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const CWD = path.resolve(import.meta.dir, "..", "..")

/** Quante richieste di permesso sono arrivate. */
let permessiChiesti: Array<{ permission: string; patterns: string[] }> = []
let richiesteMain = 0
/**
 * Tetto di sicurezza sul fake: se un rifiuto non fermasse la sessione, il
 * finto continuerebbe a chiedere all'infinito e il test misurerebbe un
 * timeout invece dell'esito. Stessa protezione di `run-permission-ask.test.ts`,
 * che e' la versione verificata (misurato senza tetto: 21 richieste e processo
 * ancora vivo a 120s).
 */
const TETTO = 6
/** Cosa fa il finto: al turno N, che tool chiede. */
let piano: (n: number) => { nome: string; args: Record<string, string> } | undefined =
  () => undefined
let tentativi = 0

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return {
    id: "c1", object: "chat.completion.chunk", created: 0, model: "finto",
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function streamTesto(testo: string) {
  return new Response(
    `data: ${JSON.stringify(chunk({ content: testo }, "stop"))}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

/** Turno che chiede un tool. */
function streamTool(nome: string, args: Record<string, string>) {
  const c = [
    chunk({ role: "assistant" }, null),
    chunk(
      {
        tool_calls: [
          {
            index: 0, id: "call_1", type: "function",
            function: { name: nome, arguments: JSON.stringify(args) },
          },
        ],
      },
      null,
    ),
    chunk({}, "tool_calls"),
  ]
  return new Response(c.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

function avviaProvider() {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.includes("/chat/completions")) {
        return new Response("unexpected " + url.pathname, { status: 404 })
      }
      const body = JSON.parse(await req.text()) as { tools?: unknown[] }
      const main = (body.tools?.length ?? 0) > 0
      if (!main) return streamTesto("titolo")
      if (++richiesteMain > TETTO) return streamTesto("basta cosi")
      const target = piano(richiesteMain - 1)
      if (target === undefined) return streamTesto("basta cosi")
      return streamTool(target.nome, target.args)
    },
  })
}

const home = mkdtempSync(path.join(tmpdir(), "run-auto-"))
const root = mkdtempSync(path.join(tmpdir(), "run-auto-root-"))
const progetto = path.join(root, "programma")
mkdirSync(progetto, { recursive: true })
writeFileSync(path.join(progetto, "scope.md"), "# scope\n")
const fuori = path.join(root, "fuori.md")
/** Scrittura DENTRO il progetto: e' l'unico modo per ottenere un `ask` vero
 *  con il perimetro attivo. `ls` e' read-only e non chiede NULLA (misurato:
 *  con `ls` il test riceveva output vuoto, perche' `patterns.add()` scatta
 *  solo per i comandi classificati `write`). */
const dentro = path.join(progetto, "appunto.txt")

const server = avviaProvider()
afterAll(() => {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

async function esegui(extra: string[]) {
  permessiChiesti = []
  richiesteMain = 0
  const config = {
    $schema: "https://cyberstrike.io/config.json",
    provider: {
      finto: {
        npm: "@ai-sdk/openai-compatible",
        name: "finto",
        options: { baseURL: `${server.url.origin}/v1`, apiKey: "test" },
        models: { test: { name: "finto test" } },
      },
    },
  }
  const proc = Bun.spawn(
    [
      "bun", "run", "--conditions=browser", "./src/index.ts", "run", "prova",
      "--model", "finto/test", ...extra,
    ],
    {
      cwd: CWD,
      env: {
        ...process.env,
        CYBERSTRIKE_HOME: home,
        CYBERSTRIKE_CONFIG_CONTENT: JSON.stringify(config),
        CYBERSTRIKE_DISABLE_SHARE: "true",
        CYBERSTRIKE_DISABLE_MODELS_FETCH: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => proc.kill(), 100_000)
  const [so, se, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, out: so + se }
}

describe("run --auto: simula un operatore, senza toccare i deny", () => {
  test("CON --auto: un permesso in `ask` viene concesso e il tool gira", async () => {
    // L'`ask` che si puo' misurare col perimetro attivo. Non uso `read`:
    // `buildProjectRuleset` chiude con `{ read: "*", allow }`, quindi sotto
    // perimetro la lettura e' concessa OVUNQUE e non esiste alcun `ask` da
    // misurare (misurato: `Read *.env` concesso anche senza `--auto`).
    //
    // Uso `glob`: chiama `ctx.ask({ permission: "glob" })` in modo diretto
    // (glob.ts:22), ed e' l'esatto permesso che nel run reale del 2026-10-02
    // fermava tutto al secondo tool. Non uso `bash`: `patterns.add()` scatta
    // solo per i comandi classificati `write`, quindi `ls` non chiede NULLA e
    // `bash` richiede anche `description` (misurato: output vuoto).
    tentativi = 0
    piano = () =>
      tentativi++ === 0
        ? { nome: "glob", args: { pattern: "*", path: progetto } }
        : undefined
    const r = await esegui(["--perimeter", progetto, "--auto"])
    // CONTROLLO DIRETTO: se il permesso e' stato concesso, il comando e'
    // girato e il suo output (i file del progetto) compare nella sessione.
    // Non mi fido del testo del modello.
    expect(r.out).toMatch(/Glob/)
    // E l'uscita non e' un fallimento: l'operatore ha approvato, quindi il
    // run puo' anche riuscire. `ask` senza operatore era exit 1 (fix B), ma
    // qui c'e' un operatore: approvare non e' fallire.
    expect(r.out).not.toMatch(/Permessi richiesti e non concessi/)
    expect(r.code).toBe(0)
  }, 200_000)

  test("CON --auto: il riepilogo dichiara che nessun umano ha valutato le azioni", async () => {
    tentativi = 0
    piano = () =>
      tentativi++ === 0
        ? { nome: "glob", args: { pattern: "*", path: progetto } }
        : undefined
    const r = await esegui(["--perimeter", progetto, "--auto"])
    // Senza questa riga `--auto` e' indistinguibile da un operatore vero:
    // l'utente non ha modo di sapere che nessuno ha valutato nulla.
    expect(r.out).toMatch(/Permessi auto-approvati/)
    expect(r.out).toMatch(/nessun operatore/i)
    expect(r.out).toMatch(/perimetro/)
  }, 200_000)

  test("CON --auto: un `deny` del perimetro resta negato", async () => {
    // Il test che rende `--auto` sicuro. `write` FUORI dal progetto e' negato
    // dal perimetro: e' un `deny`, non un `ask`, quindi non passa dal loop di
    // reply. Se `--auto` potesse approvarlo, il flag non simulerebbe un
    // operatore ma aprirebbe il confine.
    tentativi = 0
    piano = () => (tentativi++ === 0 ? { nome: "write", args: { filePath: fuori, content: "runa" } } : undefined)
    const r = await esegui(["--perimeter", progetto, "--auto"])
    // CONTROLLO POSITIVO E NEGATIVO: il file NON deve esistere, altrimenti il
    // perimetro non ha regso. Non guardo il testo del modello.
    expect(existsSync(fuori)).toBe(false)
    // E il riepilogo delle approvazioni NON deve contenere `write`: un
    // `deny` che finisce tra le auto-approvazioni significa che `--auto`
    // ha scavalcato il confine.
    expect(r.out).not.toMatch(/Permessi auto-approvati[\s\S]*write/)
  }, 200_000)

  test("SENZA --auto: l'`ask` resta negato ed esce 1", async () => {
    // Il controtesto: senza il flag il comportamento deve essere quello di
    // prima (fix B). Se questo test passasse anche con `--auto`, il flag non
    // cambierebbe niente e i test precedenti misurerebbero il default.
    tentativi = 0
    piano = () =>
      tentativi++ === 0
        ? { nome: "glob", args: { pattern: "*", path: progetto } }
        : undefined
    const r = await esegui(["--perimeter", progetto])
    expect(r.out).toMatch(/Permessi richiesti e non concessi/)
    expect(r.code).not.toBe(0)
  }, 200_000)
})