import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Database, eq } from "@/storage/db"
import { PermissionTable } from "@/session/session.sql"
import { fn } from "@/util/fn"
import { Log } from "@/util/log"
import { Wildcard } from "@/util/wildcard"
import os from "os"
import z from "zod"

export namespace PermissionNext {
  const log = Log.create({ service: "permission" })

  function expand(pattern: string): string {
    if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
    if (pattern === "~") return os.homedir()
    if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith("$HOME\\")) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
    return pattern
  }

  export const Action = z.enum(["allow", "deny", "ask"]).meta({
    ref: "PermissionAction",
  })
  export type Action = z.infer<typeof Action>

  export const Rule = z
    .object({
      permission: z.string(),
      pattern: z.string(),
      action: Action,
    })
    .meta({
      ref: "PermissionRule",
    })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = Rule.array().meta({
    ref: "PermissionRuleset",
  })
  export type Ruleset = z.infer<typeof Ruleset>

  export function fromConfig(permission: Config.Permission) {
    const ruleset: Ruleset = []
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        ruleset.push({
          permission: key,
          action: value,
          pattern: "*",
        })
        continue
      }
      ruleset.push(
        ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
      )
    }
    return ruleset
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat()
  }

  export const Request = z
    .object({
      id: Identifier.schema("permission"),
      sessionID: Identifier.schema("session"),
      permission: z.string(),
      patterns: z.string().array(),
      metadata: z.record(z.string(), z.any()),
      always: z.string().array(),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "PermissionRequest",
    })

  export type Request = z.infer<typeof Request>

  export const Reply = z.enum(["once", "always", "reject"])
  export type Reply = z.infer<typeof Reply>

  export const Approval = z.object({
    projectID: z.string(),
    patterns: z.string().array(),
  })

  export const Event = {
    Asked: BusEvent.define("permission.asked", Request),
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        reply: Reply,
      }),
    ),
  }

  /**
   * Un pattern che copre TUTTO (`*`, `**`, `?*`, `?`): non seleziona un caso,
   * seleziona un dominio. `Wildcard.match` e' la definizione di "matcha
   * qualunque stringa", quindi si usa quella invece di una lista di forme.
   */
  function coversEverything(pattern: string): boolean {
    return Wildcard.match("*", pattern)
  }

  /** Un pattern con jolly: seleziona una FAMIGLIA di valori, non un valore. */
  function hasWildcard(pattern: string): boolean {
    return /[*?]/.test(pattern)
  }

  /**
   * Permission il cui `pattern` e' TESTO DI COMANDO, non un path.
   * Una concessione di famiglia (`python3 *`) qui non e' confinabile a una
   * directory: il comando puo' scrivere ovunque, e il perimetro non ha modo di
   * accorgersene perche' la classificazione (che decide se chiedere) viene
   * saltata quando il permesso e' gia' concesso. Per queste permission la
   * famiglia non puo' diventare una concessione permanente.
   */
  const COMMAND_PERMISSIONS = new Set(["bash", "bash_unresolved"])

  /**
   * Firna del perimetro di scrittura dei progetti di bounty: un `deny` su
   * external_directory (vedi `buildProjectRuleset`, src/permission/project.ts).
   */
  function isPerimeter(ruleset: Ruleset): boolean {
    return ruleset.some((r) => r.permission === "external_directory" && r.action === "deny")
  }

  /**
   * Una concessione `allow` che NON deve partecipare alla valutazione, perche'
   * annullerebbe un confine invece di applicarlo. Due casi, entrambi provati
   * come aggirabili (vedi wayfinder/bb-autonomous-flow/tickets/
   * verifica-stato-gate-always.md):
   *
   * 1. COPRE TUTTO su una permission che il ruleset NEGA. `approved` viene
   *    valutato per ultimo (`findLast`) e vincerebbe sul `deny`: un solo
   *    `{edit, "*", allow}` — cliccato o salvato su DB — riapre una sessione
   *    che il perimetro aveva chiuso. Il confine e' una decisione di
   *    sicurezza: non si revoca con una concessione.
   *
   * 2. FAMIGLIA su una permission a testo di comando, in sessione perimetrata.
   *    `python3 *` copre `python3 -c "open('/etc/x','w')"`: dopo un click
   *    "sempre" su un comando innocuo, la scrittura fuori progetto non chiede
   *    piu' nulla.
   */
  function voidsBoundary(rule: Rule, merged: Ruleset): boolean {
    if (rule.action !== "allow") return false

    // Entrambi i casi valgono SOLO in una sessione perimetrata. Fuori da un
    // confine il ruleset e' una preferenza dell'utente e "l'ultima regola
    // vince" resta la semantica: filtrare anche li' cambierebbe il
    // significato di qualunque config che neghi e poi riammetta in blocco —
    // cosa che i test generali di `evaluate` verificano.
    if (!isPerimeter(merged)) return false

    if (coversEverything(rule.pattern) && merged.some((r) => r.permission === rule.permission && r.action === "deny"))
      return true

    if (COMMAND_PERMISSIONS.has(rule.permission) && hasWildcard(rule.pattern)) return true

    return false
  }

  const state = Instance.state(() => {
    const projectID = Instance.project.id
    const row = Database.use((db) =>
      db.select().from(PermissionTable).where(eq(PermissionTable.project_id, projectID)).get(),
    )
    const stored = row?.data ?? ([] as Ruleset)

    const pending: Record<
      string,
      {
        info: Request
        ruleset: Ruleset
        resolve: () => void
        reject: (e: any) => void
      }
    > = {}

    return {
      pending,
      approved: stored,
    }
  })

  export const ask = fn(
    Request.partial({ id: true }).extend({
      ruleset: Ruleset,
    }),
    async (input) => {
      const s = await state()
      const { ruleset, ...request } = input
      for (const pattern of request.patterns ?? []) {
        const rule = evaluate(request.permission, pattern, ruleset, s.approved)
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny")
          throw new DeniedError(ruleset.filter((r) => Wildcard.match(request.permission, r.permission)))
        if (rule.action === "ask") {
          const id = input.id ?? Identifier.ascending("permission")
          return new Promise<void>((resolve, reject) => {
            const info: Request = {
              id,
              ...request,
            }
            s.pending[id] = {
              info,
              ruleset,
              resolve,
              reject,
            }
            Bus.publish(Event.Asked, info)
          })
        }
        if (rule.action === "allow") continue
      }
    },
  )

  export const reply = fn(
    z.object({
      requestID: Identifier.schema("permission"),
      reply: Reply,
      message: z.string().optional(),
    }),
    async (input) => {
      const s = await state()
      const existing = s.pending[input.requestID]
      if (!existing) return
      delete s.pending[input.requestID]
      Bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })
      if (input.reply === "reject") {
        existing.reject(input.message ? new CorrectedError(input.message) : new RejectedError())
        // Reject all other pending permissions for this session
        const sessionID = existing.info.sessionID
        for (const [id, pending] of Object.entries(s.pending)) {
          if (pending.info.sessionID === sessionID) {
            delete s.pending[id]
            Bus.publish(Event.Replied, {
              sessionID: pending.info.sessionID,
              requestID: pending.info.id,
              reply: "reject",
            })
            pending.reject(new RejectedError())
          }
        }
        return
      }
      if (input.reply === "once") {
        existing.resolve()
        return
      }
      if (input.reply === "always") {
        // Alcune concessioni non possono diventare permanenti perche'
        // annullerebbero un confine (`voidsBoundary`): un `always` su un
        // pattern che copre tutto (`*`, come quello che write.ts/edit.ts
        // mandano), o una FAMIGLIA su una permission a testo di comando in
        // sessione perimetrata (`python3 *`). Le prime due lascierebbero
        // `approved` vincere sul `deny` del progetto; la terza coprirebbe
        // comandi che scrivono fuori progetto senza che la classificazione
        // (che decide se chiedere) venga piu' consultata. In entrambi i casi
        // l'utente approva solo questa volta — e la decisione e' esplicita
        // qui, non un filtro silenzioso a valle.
        const ampi = existing.info.always.filter((pattern) =>
          voidsBoundary({ permission: existing.info.permission, pattern, action: "allow" }, existing.ruleset),
        )
        for (const pattern of ampi) {
          log.info("always limited by perimeter", { permission: existing.info.permission, pattern })
        }

        for (const pattern of existing.info.always) {
          if (ampi.includes(pattern)) continue
          s.approved.push({
            permission: existing.info.permission,
            pattern,
            action: "allow",
          })
        }

        existing.resolve()

        const sessionID = existing.info.sessionID
        for (const [id, pending] of Object.entries(s.pending)) {
          if (pending.info.sessionID !== sessionID) continue
          const ok = pending.info.patterns.every(
            (pattern) => evaluate(pending.info.permission, pattern, s.approved).action === "allow",
          )
          if (!ok) continue
          delete s.pending[id]
          Bus.publish(Event.Replied, {
            sessionID: pending.info.sessionID,
            requestID: pending.info.id,
            reply: "always",
          })
          pending.resolve()
        }

        // TODO: we don't save the permission ruleset to disk yet until there's
        // UI to manage it
        // db().insert(PermissionTable).values({ projectID: Instance.project.id, data: s.approved })
        //   .onConflictDoUpdate({ target: PermissionTable.projectID, set: { data: s.approved } }).run()
        return
      }
    },
  )

  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    const merged = merge(...rulesets).filter((rule) => rule && rule.permission && rule.pattern && rule.action)
    // Le concessioni che annullerebbero un confine non entrano nella
    // valutazione: il filtro sta QUI, dove ruleset e concessioni sono
    // visibili insieme, quindi vale per ogni canale (click interattivo, lista
    // salvata su DB, regola di config). Filtrare solo in `reply` lasciava
    // aperto il canale persistito.
    const effective = merged.filter((rule) => !voidsBoundary(rule, merged))
    log.debug("evaluate", { permission, pattern, rules: effective.length, filtered: merged.length - effective.length })
    const match = effective.findLast(
      (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
    )
    const result = match ?? { action: "ask", permission, pattern: "*" }
    if (result.action !== "allow") log.debug("evaluate", { permission, pattern, action: result.action })
    return result
  }

  const EDIT_TOOLS = ["edit", "write", "patch", "multiedit"]

  export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    const result = new Set<string>()
    for (const tool of tools) {
      const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool

      const rule = ruleset.findLast((r) => Wildcard.match(permission, r.permission))
      if (!rule) continue
      if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
    }
    return result
  }

  /** User rejected without message - halts execution */
  export class RejectedError extends Error {
    constructor() {
      super(`The user rejected permission to use this specific tool call.`)
    }
  }

  /** User rejected with message - continues with guidance */
  export class CorrectedError extends Error {
    constructor(message: string) {
      super(`The user rejected permission to use this specific tool call with the following feedback: ${message}`)
    }
  }

  /** Auto-rejected by config rule - halts execution */
  export class DeniedError extends Error {
    constructor(public readonly ruleset: Ruleset) {
      // Show only the rule(s) that actually deny (or a small sample), plus a
      // count of the rest. Serializing the full ruleset here used to embed
      // ~15k skill-derived allow rules into the message (multi-MB), which then
      // got fed back into the model context and overflowed the window.
      const denies = ruleset.filter((r) => r.action === "deny")
      const shown = (denies.length ? denies : ruleset).slice(0, 10)
      const omitted = ruleset.length - shown.length
      const suffix = omitted > 0 ? ` (and ${omitted} more matching rule${omitted === 1 ? "" : "s"} omitted)` : ""
      super(
        `The user has specified a rule which prevents you from using this specific tool call. Relevant rules: ${JSON.stringify(shown)}${suffix}`,
      )
    }
  }

  export async function list() {
    const s = await state()
    return Object.values(s.pending).map((x) => x.info)
  }
}
