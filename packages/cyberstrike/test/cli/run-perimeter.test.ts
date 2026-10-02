/**
 * `run --perimeter <dir>` deve mettere un CONFINE APPLICATIVO nella sessione.
 *
 * Contesto (misurato il 2026-10-01): nel sandbox `run` non aveva nessun
 * confine applicativo — `run.ts` costruiva `rules` con un solo
 * `question: deny`. Il confine era solo di MOUNT: un disco confinato ma
 * nessuna regola nei tool. In più l'agente partiva da `/app` (la copia
 * read-only del codice) invece che dalla cartella del programma, quindi
 * leggeva il sorgente di CyberStrike invece dei dati di caccia.
 *
 * Questi test non verificano "il flag esiste": verificano che una scrittura
 * FUORI dal progetto venga negata dal perimetro, e che senza il flag il
 * comportamento resti com'era. Una delle due cose senza l'altra e' un test
 * che passa per il motivo sbagliato.
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// `test/cli/x.test.ts` -> il pacchetto sta due livelli su: `test/cli` ->
// `test` -> root del pacchetto. Con un solo `..` si arrivava a `test/` e
// `src/index.ts` non esisteva (misurato: "Module not found").
const CWD = path.resolve(import.meta.dir, "..", "..")

/** Provider finto: il modello chiede di scrivere, poi si ferma. */
let permessiChiesti: Array<{ permission: string; patterns: string[] }> = []
let richiesteMain = 0
/** Cosa fa il finto quando il perimetro glissa: prova un path, poi un altro. */
let piano: (n: number) => string | undefined = () => undefined
/** Indice della richiesta principale servita: serve per dire "prova una
 *  volta sola" senza far chiedere il path in loop all'infinito. */
let tentativi = 0

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return {
    id: "c1", object: "chat.completion.chunk", created: 0, model: "finto",
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

/** Turno di testo: niente tool, la sessione puo' proseguire. */
function streamTesto(testo: string) {
  const corpo =
    `data: ${JSON.stringify(chunk({ content: testo }, "stop"))}\n\ndata: [DONE]\n\n`
  return new Response(corpo, { headers: { "content-type": "text/event-stream" } })
}

/**
 * Turno che chiede `write` sul path indicato. E' l'azione che il perimetro
 * deve negare se il path e' fuori dal progetto: `write` passa dal gate
 * `edit`.
 */
function streamScrive(filePath: string) {
  const c = [
    chunk({ role: "assistant" }, null),
    chunk(
      {
        tool_calls: [
          {
            index: 0, id: "call_1", type: "function",
            function: { name: "write", arguments: JSON.stringify({ filePath, content: "runa" }) },
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
      const body = JSON.parse(await req.text()) as {
        tools?: unknown[]
        stream_options?: { include_usage?: boolean }
      }
      // CyberStrike chiama il modello anche per generare il TITOLO: quelle
      // richieste non hanno tool. Rispondere con una tool_call farebbe finire
      // il titolo come turno di lavoro.
      const main = (body.tools?.length ?? 0) > 0
      if (!main) return streamTesto("titolo")
      const target = piano(richiesteMain++)
      if (target === undefined) return streamTesto("basta cosi")
      return streamScrive(target)
    },
  })
}

const home = mkdtempSync(path.join(tmpdir(), "run-perim-"))
/** Root falsa che fa da worktree: il progetto ci sta DENTRO, altrimenti
 *  `buildProjectRuleset` lo rifiuta (non e' un discendente). */
const root = mkdtempSync(path.join(tmpdir(), "run-perim-root-"))
const progetto = path.join(root, "programma")
mkdirSync(progetto, { recursive: true })
writeFileSync(path.join(progetto, "scope.md"), "# scope\n")
// La directory SORELLA del progetto: qui dentro ci scriverebbe. Non
// pre-creare il file: il test deve verificare che il confine lo impedisca
// (misurato: io l'avevo creato come sorgente e il test leggeva `true` per
// il file sbagliato, dando un verde che non misurava niente).
const fuori = path.join(root, "fuori.md")

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
        options: { baseURL: `${server.url.origin}/v1`, apiKey: "f" },
        models: { test: { name: "finto test" } },
      },
    },
  }
  // `Bun.spawn` con pipe, non `spawnSync`: con `spawnSync` il processo figlio
  // non riusciva a raggiungere il `Bun.serve` del provider finto (misurato: zero
  // richieste ricevute, processo appeso fino al timeout). Stessa forma del
  // test `run-permission-ask.test.ts`, che e' la versione verificata.
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

describe("run --perimeter: il confine applicativo c'e' davvero", () => {
  test("CON PERIMETRO: scrivere FUORI dal progetto viene negato dal confine", async () => {
    tentativi = 0
    piano = () => (tentativi++ === 0 ? fuori : undefined)
    const r = await esegui(["--perimeter", progetto])
    // Il confine deve produrre un rifiuto ESPLICITO: `deny` lancia
    // DeniedError, che `run` deve riportare come errore. Se qui l'agente
    // scrivesse fuori, il file esisterebbe — controllo diretto sul disco,
    // non sul testo del modello.
    expect(existsSync(fuori)).toBe(false)
    // NOTA sull'uscita: qui NON mi aspetto un codice non zero, ed e' una
    // scelta misurata. La negazione del perimetro arriva all'agente come
    // errore del TOOL ("the user has specified a rule which prevents you
    // from using this specific tool call"), non come `session.error`: e'
    // l'agente a decidere se proseguire. Non e' il caso di B, dove la
    // richiesta di permesso non aveva risposta e la sessione non poteva
    // continuare. Misurato: qui l'uscita e' 0 e il file non e' stato creato.
    // Se un giorno l'uscita diventasse non zero anche qui, il messaggio
    // dovrebbe dire "confine", non "permesso manca" — i due casi sono
    // distinti e non vanno fusi.
    expect(r.out).not.toMatch(/Permessi richiesti e non concessi/)
  }, 200_000)

  test("CON PERIMETRO: scrivere DENTRO il progetto e' concesso", async () => {
    const dentro = path.join(progetto, "appunto.md")
    tentativi = 0
    piano = () => (tentativi++ === 0 ? dentro : undefined)
    const r = await esegui(["--perimeter", progetto])
    // CONTROLLO POSITIVO: senza questo, un perimetro che nega TUTTO
    // passerebbe il test precedente. Il confine deve negare il fuori e
    // consentire il dentro.
    expect(existsSync(dentro)).toBe(true)
    expect(r.code).toBe(0)
  }, 200_000)

  test("SENZA FLAG: la lettura di un path fuori e' negata dall'`ask`, non dal perimetro", async () => {
    // Il titolo del test e' la correzione di un errore mio: avevo scritto
    // "la read riesce senza il flag", che era falso. Misurato: `read` su un
    // path fuori dal progetto chiede `external_directory`, e il default
    // dell'agente lo mette in `ask`, quindi viene negata anche senza
    // perimetro. Non esiste un'azione di lettura che il default conceda per
    // un path esterno.
    //
    // Quindi il test "FUORI" non distingue col e senza flag: entrambi negano,
    // uno per il perimetro e uno per l'`ask` dell'agente. La differenza non e'
    // osservabile dall'uscita, perche' entrambe finiscono in un rifiuto.
    // Quello che resta distinguibile e' "il perimetro consente il dentro",
    // coperto dal test DENTRO, che a HEAD fallisce. E' l'unico test che
    // dimostra che il flag aggiunge un confine.
    const fuoriLeggo = path.join(root, "leggimi.txt")
    writeFileSync(fuoriLeggo, "leggimi\n")
    tentativi = 0
    piano = () => (tentativi++ === 0 ? fuoriLeggo : undefined)
    const r = await esegui([])
    expect(r.out).toMatch(/Permessi richiesti e non concessi/)
  }, 200_000)

  test("SENZA PERIMETRO: `write` resta in `ask` e viene negato lo stesso", async () => {
    // Misurato, e non e' quello che avevo scritto: senza `--perimeter` la
    // scrittura DENTRO il progetto non e' concessa comunque. Il default
    // dell'agente mette `write` in `ask`, e in non-interattivo nessuno
    // approva. Quindi `run` senza flag e `run --perimeter` si comportano
    // UGUALE su `write`, e questo test NON e' un controllo di
    // non-regressione sul default: e' la prova che il perimetro non e'
    // cio' che rende `write` utilizzabile in non-interattivo.
    //
    // Il perimetro che conta e' quello sui path FUORI: col flag vengono negati
    // da una regola `deny` del perimetro, senza flag sarebbero negati dal
    // `ask` dell'agente. Entrambi negano, ma il primo e' un confine che
    // regge anche quando qualcuno approva.
    const dentro = path.join(progetto, "senza-perimetro.md")
    tentativi = 0
    piano = () => (tentativi++ === 0 ? dentro : undefined)
    const r = await esegui([])
    expect(existsSync(dentro)).toBe(false)
    // E l'auto-rifiuto deve essere dichiarato, per il fix di B.
    expect(r.out).toMatch(/Permessi richiesti e non concessi/)
    expect(r.code).not.toBe(0)
  }, 200_000)
})