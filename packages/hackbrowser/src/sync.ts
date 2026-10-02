// bb sync — fetch real program data from HackerOne's public GraphQL endpoint.
//
// Discovery (2026-09-24, real probes): the /v1/hackers REST API always
// requires auth (401), BUT hackerone.com's own GraphQL endpoint
// (POST https://hackerone.com/graphql) serves anonymous queries for public
// programs: team info + policy, structured_scopes (asset, type,
// eligible_for_bounty/submission, instruction), and the per-asset bounty
// table (low/medium/high/critical). This makes sync fully automatic —
// no API token needed for public programs.
//
// All writes go through saveProgram() (bugbounty manager) — the same file
// the crawler reads, so a synced program is immediately crawlable.

import { getBugBountyManager, loadHunterCredentials } from "./bugbounty.ts"
import * as nodeFs from "node:fs"
import path from "node:path"

const GRAPHQL_URL = "https://hackerone.com/graphql"
const API_BASE = "https://api.hackerone.com/v1/hackers"
const UA = "Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0"

async function gql<T = any>(query: string, variables?: Record<string, unknown>, url = GRAPHQL_URL): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA, accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`HackerOne GraphQL HTTP ${res.status}`)
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (json.errors?.length) throw new Error(`HackerOne GraphQL: ${json.errors[0]?.message}`)
  if (!json.data) throw new Error("HackerOne GraphQL: empty data")
  return json.data
}

const TEAM_QUERY = `
query($handle:String!){
  team(handle:$handle){
    id name handle submission_state
    offers_bounties
    policy_setting { policy last_policy_change_at }
    declarative_policy { has_open_scope scope_exclusions { id category details } }
    structured_scopes(first:100){
      edges{ node{
        id asset_identifier asset_type eligible_for_bounty eligible_for_submission instruction
        max_severity
      }}
    }
    bounty_table{
      bounty_table_rows(first:100){ edges{ node{
        name low medium high critical
        structured_scope { asset_identifier }
      }}}
    }
  }
}`

interface ScopeNode {
  id: string
  asset_identifier: string
  asset_type: string
  eligible_for_bounty: boolean
  eligible_for_submission: boolean
  instruction: string | null
  max_severity?: string | null
}

interface BountyRow {
  name: string
  low: number | null
  medium: number | null
  high: number | null
  critical: number | null
  structured_scope: { asset_identifier: string } | null
}

interface TeamData {
  team: {
    id: string
    name: string
    handle: string
    submission_state: string
    offers_bounties: boolean
    policy_setting: { policy: string; last_policy_change_at: string } | null
    declarative_policy: { has_open_scope: boolean | null; scope_exclusions: { id: string; category: string; details: string }[] } | null
    structured_scopes: { edges: { node: ScopeNode }[] }
    bounty_table: { bounty_table_rows: { edges: { node: BountyRow }[] } } | null
  }
}

const fmt = (n: number | null | undefined) => (n == null ? null : `$${n.toLocaleString("en-US")}`)

/**
 * Seconda fonte, complementare a GraphQL: quando `bb connect` ha salvato un
 * token API, questo apre api.hackerone.com/v1/hackers/*, che il GraphQL del
 * sito IGNORA (misurato 2026-10-01: `401 Invalid authentication token` — i
 * due endpoint non si parlano).
 *
 * Cosa dà il token e cosa NO, misurato:
 * - DÀ  la policy INTEGRALE (l'anonimo ne tronca 500 caratteri) e l'elenco dei
 *   programmi che l'utente può vedere.
 * - NON dà lo scope strutturato (`/programs/<id>/structured_scopes` → 404
 *   "Team does not exist"), e su un campione di 25 programmi nessuno era
 *   privato: per un cacciatore il privato NON è un dato leggibile. Quindi lo
 *   scope resta anonimo, e non è una scelta ma un limite dell'API.
 *
 * Ogni errore qui è NON FATALE per scelta: un token scaduto non deve far
 * perdere la sincronizzazione che l'anonimo sa fare da solo.
 */
async function withToken(
  handle: string,
  apiBase = API_BASE,
): Promise<{ policy?: string; visiblePrograms?: string[]; tokenRejected?: boolean }> {
  const creds = loadHunterCredentials()
  if (!creds?.api_token || !creds?.api_identifier) return {}
  const auth = `Basic ${Buffer.from(`${creds.api_identifier}:${creds.api_token}`).toString("base64")}`
  try {
    // NB: la lista e' PAGINATA e il programma puo' non stare in pagina 1 —
    // misurato su bcny: non e' nei primi 100 handle della pagina 1, quindi
    // con una sola richiesta la policy intera non arrivava MAI. Si scorre
    // fino a trovare il programma, con un tetto di pagine.
    let programs: string[] = []
    let policy: string | undefined
    let rejected = false
    // NB: NON fermarsi quando si trova il programma. La lista e' quella che
    // viene mostrata all'utente ("cosa posso cacciare"): fermarsi alla pagina
    // che contiene il programma la lascerebbe TRONCATA senza dirlo (misurato
    // da un verificatore indipendente: 2 handle su 3, e sul reale 100 su 595).
    for (let page = 1; page <= 10; page++) {
      const res = await fetch(`${apiBase}/programs?page%5Bsize%5D=100&page%5Bnumber%5D=${page}`, {
        headers: { accept: "application/json", "user-agent": UA, authorization: auth }
      })
      if (!res.ok) {
        // 401/403 = il token non e' buono. Non e' la stessa cosa di "l'utente
        // non vede programmi": restituire [] farebbe leggere a chi chiama un
        // elenco VUOTO come se fosse la risposta reale.
        rejected = res.status === 401 || res.status === 403
        break
      }
      const json = (await res.json()) as {
        data?: { attributes?: { handle?: string; policy?: string } }[]
        links?: { next?: string | null }
      }
      const rows = json.data ?? []
      if (!rows.length) break
      programs.push(...rows.map((r) => r.attributes?.handle).filter((h): h is string => !!h))
      // non sovrascrivere: le altre pagine hanno policy "" e azzererebbero
      // quella appena trovata
      policy ??= rows.find((r) => r.attributes?.handle === handle)?.attributes?.policy
      if (!json.links?.next) break
    }
    return { policy, visiblePrograms: rejected ? undefined : programs, tokenRejected: rejected }
  } catch {
    return {}
  }
}

export interface SyncEndpoints {
  /** Endpoint GraphQL del sito (anonimo): unica fonte per lo scope. */
  graphqlURL?: string
  /** Base REST autenticata: serve solo per policy intera + elenco programmi. */
  apiBase?: string
}

/**
 * Sync a public HackerOne program: fetch live data via anonymous GraphQL and
 * write the program JSON through the BugBountyManager. Returns a summary.
 * Throws on unknown handle / non-public program.
 */
export async function syncProgram(
  handle: string,
  endpoints: SyncEndpoints = {},
): Promise<{
  name: string
  inScope: string[]
  outScope: string[]
  bountyAssets: number
  rulesChars: number
  /** Presente solo se c'era un token valido: cosa può vedere questo utente. */
  visiblePrograms?: string[]
  /** true se la policy è arrivata intera dalla REST invece dei 500 caratteri. */
  fullPolicy?: boolean
}> {
  const data = await gql<TeamData>(TEAM_QUERY, { handle }, endpoints.graphqlURL)
  const team = data.team
  if (!team?.id) throw new Error(`Program '${handle}' not found on HackerOne`)

  const scopes = team.structured_scopes.edges.map((e) => e.node)
  const inScope = scopes.filter((s) => s.eligible_for_submission).map((s) => s.asset_identifier)
  const outScope = scopes.filter((s) => !s.eligible_for_submission).map((s) => s.asset_identifier)

  // Bounty rows: keep only numeric tiers, keyed by the scope's asset identifier
  // when present (product-name rows like "Dia on MacOS" have no scope link —
  // their payouts land in payout_focus as product hints).
  const rows = team.bounty_table?.bounty_table_rows.edges.map((e) => e.node) ?? []
  const byAsset = new Map<string, { low?: string; medium?: string; high?: string; critical?: string }>()
  for (const r of rows) {
    const asset = r.structured_scope?.asset_identifier
    if (!asset) continue
    byAsset.set(asset, {
      ...(r.low != null ? { low: fmt(r.low)! } : {}),
      ...(r.medium != null ? { medium: fmt(r.medium)! } : {}),
      ...(r.high != null ? { high: fmt(r.high)! } : {}),
      ...(r.critical != null ? { critical: fmt(r.critical)! } : {}),
    })
  }
  // Program-wide focus tiers = max across rows
  const maxTier = (pick: (r: BountyRow) => number | null) => {
    const vals = rows.map(pick).filter((v): v is number => v != null)
    return vals.length ? fmt(Math.max(...vals)) : null
  }

  const manager = getBugBountyManager()
  // Preserve local-only state (accounts live in a separate file; identity kept)
  let previous
  try {
    manager.loadProgram(handle)
    previous = manager.getProgramConfig()
  } catch {
    previous = undefined
  }

  const cfg: Parameters<ReturnType<typeof getBugBountyManager>["addProgram"]>[1] = {
    name: handle,
    platform: "hackerone",
    programUrl: `https://hackerone.com/${handle}`,
    description: team.name,
    scope: { in: inScope, out: outScope },
    payouts: {
      low: maxTier((r) => r.low) ?? "n/a",
      medium: maxTier((r) => r.medium) ?? "n/a",
      high: maxTier((r) => r.high) ?? "n/a",
      critical: maxTier((r) => r.critical) ?? "n/a",
    },
    rules: {
      ...(previous?.rules?.maxSteps ? { maxSteps: previous.rules.maxSteps } : { maxSteps: 100 }),
      authenticated: false,
      custom: [
        `submission_state: ${team.submission_state}`,
        `offers_bounties: ${team.offers_bounties}`,
        ...(byAsset.size
          ? [`Per-asset payouts: ${[...byAsset.entries()].map(([a, p]) => `${a} ${p.critical ?? p.high ?? "?"} crit`).join("; ")}`]
          : []),
        ...(team.declarative_policy?.scope_exclusions ?? []).map((e) => `EXCLUSION ${e.category}: ${e.details}`),
      ],
    },
    identity: previous?.identity,
    lastUpdated: new Date().toISOString(),
  }

  // Policy text (program rules). Anonymous GraphQL returns it; with a token the
  // REST copy is the FULL text (the excerpt below is the anonymous one, so
  // prefer the token's when it exists and is longer). The full text is cached
  // alongside for reference; only a 500-char excerpt goes into the JSON, to
  // keep the prompt sane.
  const anon = team.policy_setting?.policy ?? ""
  const tok = await withToken(handle, endpoints.apiBase)
  const policy = tok.policy && tok.policy.length > anon.length ? tok.policy : anon
  if (policy) cfg.rules!.custom!.push(`policy_excerpt: ${policy.slice(0, 500).replaceAll(/\s+/g, " ")}…`)
  manager.addProgram(handle, cfg as never)
  if (policy) {
    // La policy va DENTRO `programs/<handle>/`, non nella root di bugbounty.
    //
    // Il perimetro del sandbox copre una sola directory di programma: se la
    // policy sta nella root, l'agente la dichiara irraggiungibile e si ferma
    // (misurato: `Read /work/bugbounty/bcny.policy.md` negato dal perimetro).
    // Dentro la directory del programma e' leggibile per costruzione.
    //
    // La copia nella root non viene rimossa: li' vive il testo che
    // `bb sync` aveva gia' scritto e altri strumenti potrebbero guardarlo.
    // Perche' non e' piu' la fonte? Perche' due copie divergono e quella
    // dentro il perimetro e' quella che l'agente legge davvero: deve essere
    // l'unica dichiarata come «leggi questa», altrimenti `AGENTS.md` e il
    // file reale non coincidono. `AGENTS.md` e' generato dallo stesso path
    // che questa funzione usa, quindi i due non possono divergere.
    const dir = (manager as unknown as { programsDir: string }).programsDir
    // Import statici in fondo al file, per la stessa ragione del resto del
    // progetto: gli import dinamici dentro la funzione non risolvono i tipi.
    const { writeFileSync, mkdirSync } = nodeFs
    const programDir = path.join(dir, "programs", handle)
    mkdirSync(programDir, { recursive: true })
    writeFileSync(path.join(programDir, `${handle}.policy.md`), policy)
  }

  return {
    name: team.name,
    inScope,
    outScope,
    bountyAssets: byAsset.size,
    rulesChars: policy.length,
    visiblePrograms: tok.visiblePrograms,
    fullPolicy: !!tok.policy && tok.policy.length > anon.length,
  }
}
