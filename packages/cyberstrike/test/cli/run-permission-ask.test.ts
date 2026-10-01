import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

/**
 * `run` in modalita' non interattiva: quando una richiesta di permesso non
 * puo' essere risposta da nessuno, il fallimento deve essere VISIBILE.
 *
 * Difetto misurato il 2026-10-01 simulando `bb hunt bcny` nel container:
 * il perimetro di un programma mette `ask` su `bash` (difesa voluta, e non
 * da toccare), e `run.ts` rispondeva `"reject"` a OGNI richiesta in
 * non-interattivo. L'agente si e' arreso in silenzio e `run` ha restituito
 * **exit 0**: successo dichiarato su una sessione che non aveva prodotto
 * nulla (nessuno state.json, nessun report, browser mai avviato). Un test
 * di perimetro puo' leggere quel 0 come verde.
 *
 * Secondo difetto nello stesso file: `let error` raccoglieva gli eventi
 * `session.error` e non era MAI letto, quindi una sessione fallita usciva
 * comunque 0.
 *
 * Perche' serve il processo vero: il difetto e' nell'uscita del processo e
 * nel fatto che i rifiuti non vengono contati. Un test che importa `run.ts`
 * e guarda una funzione interna resterebbe verde col difetto vivo.
 *
 * Il modello e' finto e locale: `permission.asked` e' un evento emesso dal
 * perimetro, non serve alcuna rete esterna per produrlo.
 *
 * La config passa per `CYBERSTRIKE_CONFIG_CONTENT`: `xdgConfig` e' calcolato
 * al CARICAMENTO del modulo (`global/index.ts`), quindi scrivere
 * `XDG_CONFIG_HOME` dal test non ha effetto — misurato: il provider finto
 * non veniba caricato e il test misurava `ModelNotFoundError`, cioe' un
 * difetto diverso da quello annunciato.
 */

let server: ReturnType<typeof Bun.serve>
/** Chiamate main servite, e tetto oltre il quale il finto chiude il turno. */
let chiamate = 0
const TETTO = 6
/**
 * Cosa deve fare il finto nella richiesta principale. Ogni test lo imposta:
 * COSA` chiede il permesso, `NULLA` risponde e basta. Senza questo i due test
 * misurerebbero lo stesso scenario e la controprova non controllerebbe
 * niente.
 */
let piano: () => Response = () => streamTesto("ok")

afterAll(() => {
  server?.stop(true)
})

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.includes("/chat/completions")) {
        return new Response("unexpected " + url.pathname, { status: 404 })
      }
      const body = JSON.parse(await req.text()) as { tools?: unknown[] }
      // CyberStrike chiama il modello per generare il TITOLO prima della
      // sessione vera: quelle richieste non hanno tool. Rispondere anche a
      // quelle con un tool_call farebbe finire il titolo come turno di lavoro
      // e la sessione non partirebbe — misurato.
      const main = (body.tools?.length ?? 0) > 0
      if (!main) return streamTesto("titolo finto")
      // Tetto di sicurezza. Se il rifiuto non fermasse la sessione, il finto
      // continuerebbe a chiedere all'infinito e il test misurerebbe un timeout
      // invece dell'uscita. Dopo il tetto chiude il turno con `stop`: la
      // sessione termina comunque e l'uscita resta attribuibile al rifiuto.
      // Misurato senza tetto: 21 richieste e il processo ancora vivo a 120s.
      if (++chiamate > TETTO) return streamTesto("basta")
      return piano()
    },
  })
})

/** Turno di testo: niente tool, la sessione puo' proseguire. */
function streamTesto(testo: string) {
  const c = {
    id: "c0", object: "chat.completion.chunk", created: 0, model: "finto",
    choices: [{ index: 0, delta: { content: testo }, finish_reason: "stop" }],
  }
  return new Response(`data: ${JSON.stringify(c)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

/**
 * SSE: il modello chiede `read` su un `.env`. Il default dell'agente mette
 * `read: {"*.env": "ask"}`, quindi il perimetro chiede approvazione e in
 * non-interattivo nessuno risponde.
 */
function streamAskingRead() {
  const chunks = [
    {
      id: "c1", object: "chat.completion.chunk", created: 0, model: "finto",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id: "c1", object: "chat.completion.chunk", created: 0, model: "finto",
      choices: [{
        index: 0,
        // `index` non e' facoltativo: senza questo l'SDK rifiuta il chunk con
        // AI_TypeValidationError e il test misurerebbe quello, non il rifiuto.
        // Misurato: il rosso a HEAD era verde per il motivo sbagliato.
        delta: { tool_calls: [{ index: 0, id: "call_1", type: "function",
          function: { name: "read", arguments: JSON.stringify({ filePath: "/etc/prova.env" }) } }] },
        finish_reason: null,
      }],
    },
    {
      // `tool_calls` e NON `stop`: con `stop` l'SDK considera il turno
      // finito e scarta la chiamata, il permesso non viene MAI chiesto e il
      // test misurerebbe una sessione che non ha chiesto nulla. Misurato:
      // 3 richieste al fake (titolo, titolo, main) e nessun tool eseguito.
      id: "c1", object: "chat.completion.chunk", created: 0, model: "finto",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

interface Run { code: number; out: string; ms: number }

/**
 * Lancia `cyberstrike run` col provider finto e misura l'uscita.
 * `permission` e' il ruleset di prova, in forma di config.
 */
async function run(permission: Record<string, string>, msg = "di' ciao"): Promise<Run> {
  const config = {
    $schema: "https://cyberstrike.io/config.json",
    provider: {
      finto: {
        npm: "@ai-sdk/openai-compatible",
        name: "finto",
        options: { baseURL: `${server.url.origin}/v1`, apiKey: "finto" },
        models: { test: { name: "finto test" } },
      },
    },
    permission,
  }
  await using tmp = await tmpdir()
  chiamate = 0
  const t0 = Date.now()
  const proc = Bun.spawn(
    ["bun", "run", "--conditions=browser", "./src/index.ts", "run", msg, "--model", "finto/test"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CYBERSTRIKE_HOME: tmp.path,
        CYBERSTRIKE_CONFIG_CONTENT: JSON.stringify(config),
        CYBERSTRIKE_DISABLE_SHARE: "true",
        CYBERSTRIKE_DISABLE_MODELS_FETCH: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err, ms: Date.now() - t0 }
}

/**
 * Il permesso e' quello del DEFAULT dell'agente, non uno inventato: il
 * default ha `read: {"*.env": "ask"}` e `external_directory: {"*": "ask"}`.
 * Misurato: passare un ruleset via config NON funziona — `run.ts:367` costruisce
 * `rules` con un solo `question: deny` e `sdk.session.create({permission: rules})`,
 * quindi la config `permission` viene ignorata. Per far scattare l'ask il
 * test deve usare un'azione che il default mette in `ask`, non dichiarare
 * regole che verranno scartate.
 */
const NESSUN_RULESET = {} as Record<string, string>

describe("run non interattivo: permesso richiesto e nessuno che risponde", () => {
  test("esce dal progetto, nessuno approva: uscita NON zero e nomina il permesso", async () => {
    piano = streamAskingRead
    const r = await run(NESSUN_RULESET, "leggi il file di configurazione")
    // Il cuore del difetto: prima era 0.
    expect(r.code).not.toBe(0)
    // Deve DIRE QUALE permesso: un exit non zero senza spiegazione e' rumore,
    // e senza il nome non si distingue da un crash. Il permesso e'
    // `external_directory` perche' il path e' fuori dal progetto: il default
    // dell'agente lo mette in `ask` per ogni path, ed e' lo stesso evento
    // che nel run reale del 2026-10-01 aveva negato `/dev/*` in silenzio.
    expect(r.out).toMatch(/external_directory/)
    expect(r.out).toMatch(/non interattiv|nessuno|approv|umano/i)
  }, 200_000)

  test("CONTROPROVA: senza permessi richiesti l'uscita resta 0", async () => {
    // Il fix non deve trasformare ogni sessione in un errore: una sessione
    // che non chiede nulla e finisce pulita deve uscire 0 come prima.
    piano = () => streamTesto("risposta finta")
    const r = await run(NESSUN_RULESET, "di ciao")
    expect(r.code).toBe(0)
    expect(r.out).not.toMatch(/non interattiv|serve un umano/i)
  }, 180_000)
})
