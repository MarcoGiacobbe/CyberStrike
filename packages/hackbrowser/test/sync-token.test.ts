import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Difetto misurato il 2026-10-01: `bb sync` interroga SOLO
// hackerone.com/graphql in anonimo. Il token API salvato da `bb connect` non
// puo' raggiungere quell'endpoint (401 "Invalid authentication token",
// misurato), ma apre api.hackerone.com/v1/hackers/programs, che restituisce
// la policy INTEGRALE (l'anonimo ne tronca 500 caratteri) e l'elenco dei
// programmi visibili col token.
//
// Quindi: scope = anonimo (unica fonte, verificato: lo scope privato non
// esiste per un cacciatore, 404); token = policy intera + elenco programmi.
// Senza token, il comportamento deve restare identico a oggi.

const PROG = "sync-token-test-prog"
const HANDLE = "bcny"

/** Pagine del finto: il programma in pagina 2, l'elenco distribuito su 3. */
const PAGES = [["a1", "a2"], [HANDLE, "b2"], ["c1", "c2"]]

/** Server finto che imita i DUE endpoint, per non colpire HackerOne dai test. */
function serve() {
  const seen: { url: string; auth: string | null }[] = []
  const calls = { anon: 0, api: 0 }

  const anon = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({ url: new URL(req.url).pathname, auth: req.headers.get("authorization") })
      calls.anon++
      const body = (await req.json()) as { variables?: { handle?: string } }
      // la query REALE chiama la variabile `handle`, non `h`: nel primo
      // rosso il finto server rispondeva "Team does not exist" perche' cercava
      // `h`, quindi il test misurava il server finto, non la funzione.
      if (body.variables?.handle !== HANDLE)
        return Response.json({ errors: [{ message: "Team does not exist" }], data: { team: null } })
      return Response.json({
        data: {
          team: {
            id: "gid://x",
            name: "The Browser Company of NYC",
            handle: HANDLE,
            submission_state: "open",
            offers_bounties: true,
            // misurato sull'API reale: l'anonimo tronca la policy, la REST no
            policy_setting: { policy: "P".repeat(500), last_policy_change_at: "2026-01-01" },
            declarative_policy: null,
            structured_scopes: {
              edges: [{ node: { asset_identifier: "arc.net", eligible_for_submission: true } }],
            },
            bounty_table: null,
          },
        },
      })
    },
  })

  // Come l'API vera: RISPONDE 401 se il token non arriva, altrimenti la lista.
  const api = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ url: new URL(req.url).pathname, auth: req.headers.get("authorization") })
      const auth = req.headers.get("authorization")
      // come l'API vera: 401 se il token non arriva O non e' quello buono,
      // altrimenti la lista. Senza questo, 'token rotto' e indistinguibile
      // da 'token valido' e il test del fallback non misurerebbe nulla.
      const token = Buffer.from(auth.replace("Basic ", ""), "base64").toString().split(":")[1]
      if (token !== "secret-token") return Response.json({ errors: [{ status: 401 }] }, { status: 401 })
      // PAGINAZIONE REALE: 3 pagine da 2 handle, il programma in pagina 2.
      // Sul vero HackerOne la lista e' di 595 handle in 6 pagine e l'ordine
      // NON e' stabile (bcny e' in pagina 6): un finto con tutto in pagina 1
      // non misurerebbe la paginazione, che e' il punto.
      const n = Number(new URL(req.url).searchParams.get("page[number]") ?? "1")
      const page = PAGES[n - 1]
      calls.api++
      return Response.json({
        data: page.map((h) => ({ id: h, type: "program", attributes: { handle: h, name: h, policy: h === HANDLE ? "P".repeat(4000) : "" } })),
        links: { next: PAGES[n] ? `page=${n + 1}` : null },
      })
    },
  })

  return {
    anonURL: `http://localhost:${anon.port}/graphql`,
    apiURL: `http://localhost:${api.port}/v1/hackers/programs`,
    calls,
    seen,
    stop() {
      anon.stop(true)
      api.stop(true)
    },
  }
}

function homeWith(token: string | null): string {
  const h = mkdtempSync(path.join(tmpdir(), "bbtok-"))
  mkdirSync(path.join(h, "bugbounty"), { recursive: true })
  writeFileSync(
    path.join(h, "bugbounty", "credentials.json"),
    JSON.stringify(token ? { api_identifier: "me", api_token: token } : {}),
    { mode: 0o600 },
  )
  return h
}

async function sync(home: string, url: string, api: string) {
  const prev = process.env.CYBERSTRIKE_HOME
  process.env.CYBERSTRIKE_HOME = home
  try {
    // import fresco: il manager dei programmi fissa la home al primo uso
    const mod = await import(`../src/sync.ts?tok=${Math.random()}`)
    return await mod.syncProgram(HANDLE, { graphqlURL: url, apiBase: api })
  } finally {
    if (prev === undefined) delete process.env.CYBERSTRIKE_HOME
    else process.env.CYBERSTRIKE_HOME = prev
  }
}

describe("bb sync: due fonti complementari, il token NON e' obbligatorio", () => {
  test("SENZA token: solo l'anonimo, e funziona come prima", async () => {
    const s = serve()
    const home = homeWith(null)
    try {
      const r = await sync(home, s.anonURL, s.apiURL)
      expect(r.name).toBe("The Browser Company of NYC")
      expect(r.inScope).toEqual(["arc.net"])
      // il comportamento di oggi non deve cambiare: nessuna chiamata all'API
      expect(s.calls.anon).toBe(1)
      expect(s.calls.api).toBe(0)
    } finally {
      s.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })

  // Nota onesta sul nome: sul reale la policy col token e' SPESSO UGUALE
  // all'anonima (misurato su bcny: 12702 caratteri da entrambe le fonti).
  // Il vantaggio reale del token non e' la lunghezza ma che la REST non
  // tronca; qui il finto la tronca a 500 come l'anonimo vero, quindi il test
  // verifica che la sorgente col token venga USATA quando e' piu' completa.
  test("CON token: la policy arriva INTERA, non i 500 caratteri di oggi", async () => {
    const s = serve()
    const home = homeWith("secret-token")
    try {
      const r = await sync(home, s.anonURL, s.apiURL)
      const policy = await Bun.file(path.join(home, "bugbounty", `${HANDLE}.policy.md`)).text()
      expect(policy.length).toBe(4000)
      // il token non deve finire MAI in un file scritto
      expect(policy).not.toContain("secret-token")
    } finally {
      s.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("CON token valido: arriva anche l'elenco dei programmi visibili", async () => {
    const s = serve()
    const home = homeWith("secret-token")
    try {
      const r = await sync(home, s.anonURL, s.apiURL)
      expect(r.visiblePrograms).toContain(HANDLE)
    } finally {
      s.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("token NON valido: la sync ANONIMA regge e non fallisce", async () => {
    const s = serve()
    const home = homeWith("token-rotto")
    try {
      const r = await sync(home, s.anonURL, s.apiURL)
      expect(r.name).toBe("The Browser Company of NYC")
      // un token che non funziona non puo' far perdere la sincronizzazione
      // 401 = token rifiutato: si deve distinguere "non guardato" da
      // "guardato e non vedo nulla", altrimenti [] sembrerebbe una risposta.
      expect(r.visiblePrograms).toBeUndefined()
    } finally {
      s.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })

  // Difetto trovato dalla verifica indipendente (deleg_37df8766): il ciclo
  // di paginazione si fermava appena trovata la policy del programma richiesto
  // (`for (... && !policy)`), quindi l'elenco dei programmi visibili tornava
  // TRONCATO alla pagina in cui stava il programma. Sul reale bcny e' in
  // pagina 6: l'elenco risultava 100 handle invece di 595, e per un programma
  // in pagina 1 sarebbe tornato 100 su 595 senza che nulla lo segnalasse.
  test("l'elenco dei programmi arriva FINO IN FONDO, non si ferma alla pagina del programma", async () => {
    const s = serve()
    const home = homeWith("secret-token")
    try {
      const r = await sync(home, s.anonURL, s.apiURL)
      // il finto ha 3 pagine da 2: l'elenco deve contenere TUTTI i 6 handle
      // tutti e 6, nell'ordine delle pagine (bcny e' in pagina 2)
      expect(r.visiblePrograms).toEqual(["a1", "a2", HANDLE, "b2", "c1", "c2"])
    } finally {
      s.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("Nessun file del programma contiene il token", async () => {
    const s = serve()
    const home = homeWith("secret-token")
    try {
      await sync(home, s.anonURL, s.apiURL)
      const json = await Bun.file(path.join(home, "bugbounty", `${HANDLE}.json`)).text()
      expect(json).not.toContain("secret-token")
    } finally {
      s.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })
})