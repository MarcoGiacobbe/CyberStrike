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

import { getBugBountyManager } from "./bugbounty.ts"

const GRAPHQL_URL = "https://hackerone.com/graphql"
const UA = "Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0"

async function gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
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
 * Sync a public HackerOne program: fetch live data via anonymous GraphQL and
 * write the program JSON through the BugBountyManager. Returns a summary.
 * Throws on unknown handle / non-public program.
 */
export async function syncProgram(handle: string): Promise<{
  name: string
  inScope: string[]
  outScope: string[]
  bountyAssets: number
  rulesChars: number
}> {
  const data = await gql<TeamData>(TEAM_QUERY, { handle })
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

  // Policy text (program rules) — truncated to keep the JSON/prompt sane;
  // full policy cached alongside for reference.
  const policy = team.policy_setting?.policy ?? ""
  if (policy) cfg.rules!.custom!.push(`policy_excerpt: ${policy.slice(0, 500).replaceAll(/\s+/g, " ")}…`)
  manager.addProgram(handle, cfg as never)
  if (policy) {
    const dir = (manager as unknown as { programsDir: string }).programsDir
    const { writeFileSync } = await import("fs")
    writeFileSync(`${dir}/${handle}.policy.md`, policy)
  }

  return { name: team.name, inScope, outScope, bountyAssets: byAsset.size, rulesChars: policy.length }
}
