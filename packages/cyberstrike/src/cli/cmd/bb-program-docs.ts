import type { BountyProgramConfig } from "@cyberstrike-io/hackbrowser/bugbounty"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"

/**
 * I tre file che stanno nella directory di un programma.
 *
 * La domanda che questa parte deve rispondere: che cosa legge un agente appena
 * arriva, e in che ordine? La risposta e' la stessa di un progetto normale:
 * `AGENTS.md` e' l'indice (corto, dice dove trovare tutto), `scope.md` e' lo
 * scope, e la policy integrale resta sul file scritto da `bb sync`.
 *
 * Perche' NON rigenerare qui la policy. `bb sync` gia' scrive
 * `<handle>.policy.md` con il testo integrale; rigenerarlo qui duplicherebbe
 * la fonte e aprirebbe la porta a due copie che divergono. Il compito di
 * questo modulo e' il rimando, non la copia.
 */

/** Un asset e' un URL se ha un nome di dominio, non se "sembra" un indirizzo. */
function looksLikeUrl(asset: string): boolean {
  const a = asset.trim()
  if (!a) return false
  if (a.startsWith("http://") || a.startsWith("https://")) return true
  // Un id numerico (id6472513080) NON e' un dominio: non ha un punto.
  if (/^\d+$/.test(a)) return false
  // serve almeno una lettera prima del punto: `company.thebrowser.arc` sì,
  // ma `1.2.3.4` e' un indirizzo IP, non un sito web da visitare.
  return /[a-z0-9-]+\.[a-z]{2,}/i.test(a)
}

export type TargetClassification = {
  inScope: string[]
  outOfScope: string[]
  /** asset in-scope visitabili via browser */
  urls: string[]
  /**
   * Asset in-scope che NON sono siti: app desktop, estensioni, prodotti.
   * Vanno tenuti separati dagli URL perche' un agente che li legge accanto
   * agli URL puo' tentare di visitarli come se fossero pagine web.
   */
  products: string[]
  /** in-scope non classificabili come URL ne' come prodotto */
  unclassified: string[]
}

export function classifyTargets(config: BountyProgramConfig): TargetClassification {
  const inScope = config.scope?.in ?? []
  const outOfScope = config.scope?.out ?? []
  const urls: string[] = []
  const products: string[] = []
  const unclassified: string[] = []
  for (const raw of inScope) {
    const a = String(raw).trim()
    if (!a) continue
    if (looksLikeUrl(a)) urls.push(a)
    // Una riga con spazi e parole ("Arc on Mac") e' un prodotto, non un host.
    else if (/\s/.test(a)) products.push(a)
    else unclassified.push(a)
  }
  return { inScope, outOfScope, urls, products, unclassified }
}

function policyPath(config: BountyProgramConfig, programsDir: string): string {
  return path.join(programsDir, `${config.name}.policy.md`)
}

function ageDays(config: BountyProgramConfig, now = new Date()): number | null {
  if (!config.lastUpdated) return null
  const t = Date.parse(config.lastUpdated)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

export function renderScopeDoc(config: BountyProgramConfig, now = new Date()): string {
  const c = classifyTargets(config)
  const out: string[] = []
  out.push(`# Scope — ${config.name}`)
  out.push("")
  if (config.description) out.push(`${config.description}`)
  if (config.programUrl) out.push(`Programma: ${config.programUrl}`)
  const age = ageDays(config, now)
  out.push(
    age === null
      ? "Dati mai sincronizzati: lanciare `bb sync " + config.name + "` prima di fidarsi."
      : `Dati aggiornati ${age === 0 ? "oggi" : age === 1 ? "ieri" : `di ${age} giorni`}. Se ti sembrano vecchi, chiedi un \`bb sync\`.`,
  )
  out.push("")

  out.push("## Siti web in scope")
  if (c.urls.length === 0) out.push("- nessuno")
  else for (const u of c.urls) out.push(`- ${u}`)
  out.push("")

  out.push("## Prodotti in scope (non sono siti web)")
  if (c.products.length === 0) out.push("- nessuno")
  else {
    out.push("Non aprire questi come pagine web: sono app o prodotti.")
    for (const p of c.products) out.push(`- ${p}`)
  }
  out.push("")

  if (c.unclassified.length) {
    out.push("## In scope, da chiarire con l'utente")
    for (const u of c.unclassified) {
      out.push(`- ${u} (non e' un sito ne' un prodotto: chiedi prima)`)
    }
    out.push("")
  }

  if (c.outOfScope.length) {
    out.push("## FUORI scope — non toccare")
    for (const o of c.outOfScope) out.push(`- ${o}`)
    out.push("")
  }

  out.push("## Payout")
  const p = config.payouts
  if (p) {
    out.push("| severita' | importo |")
    out.push("| --- | --- |")
    for (const k of ["low", "medium", "high", "critical"] as const) {
      if (p[k] && p[k] !== "n/a") out.push(`| ${k} | ${p[k]} |`)
    }
  } else out.push("- non disponibile")
  out.push("")
  out.push("Questi sono i massimi del programma, non per singolo target.")
  return out.join("\n") + "\n"
}

export function renderAgentsDoc(
  config: BountyProgramConfig,
  programsDir: string,
  now = new Date(),
): string {
  const policy = policyPath(config, programsDir)
  const hasPolicy = existsSync(policy)
  const out: string[] = []
  out.push(`# ${config.name} — bug bounty`)
  out.push("")
  out.push("Sei dentro la directory di questo programma. Leggi questo file e poi")
  out.push("`scope.md` prima di toccare qualsiasi target.")
  out.push("")
  out.push("## Cosa c'e' qui")
  out.push("")
  out.push("- `scope.md` — cosa e' dentro e cosa no, con i payout.")
  out.push(
    hasPolicy
      ? `- La policy integrale del programma: \`${policy}\`.`
      : `- La policy integrale NON e' in locale: lanciare \`bb sync ${config.name}\` e poi rileggere questo file.`,
  )
  out.push("")
  out.push("## Regole che non si negoziano")
  out.push("")
  out.push("- Non uscire da questa directory scrivendo. Lettura ovunque, scrittura qui.")
  out.push("- Fuori scope non si tocca, punto.")
  out.push("- Nessun test di devastazione o di carico: il danno e' irreversibile e nessun bounty lo rimborsa.")
  const max = config.rules?.maxSteps
  if (max) out.push(`- Non oltre ${max} passi su un singolo target.`)
  out.push("- Ogni finding passa da `bounty_status` prima di essere considerato chiuso.")
  out.push("")
  const age = ageDays(config, now)
  if (age === null) out.push("> I dati di questo programma non sono mai stati sincronizzati.")
  else if (age >= 1) out.push(`> Dati aggiornati ${age === 1 ? "ieri" : `di ${age} giorni`}: se il target ti sembra cambiato, chiedi un \`bb sync\`.`)
  return out.join("\n") + "\n"
}

/**
 * Scrive i due file indicizzabili. La policy non viene toccata: esiste gia'.
 * Ritorna i path scritti, cosi' il chiamante puo' stamparli.
 */
export function writeProgramDocs(
  config: BountyProgramConfig,
  directory: string,
  programsDir: string,
  now = new Date(),
): { agents: string; scope: string; policy: string } {
  const agents = path.join(directory, "AGENTS.md")
  const scope = path.join(directory, "scope.md")
  writeFileSync(agents, renderAgentsDoc(config, programsDir, now), { mode: 0o600 })
  writeFileSync(scope, renderScopeDoc(config, now), { mode: 0o600 })
  return { agents, scope, policy: policyPath(config, programsDir) }
}
