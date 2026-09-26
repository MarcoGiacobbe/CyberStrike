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
import path from "path"
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
      /**
       * Marcatore ESPLICITO di confine (vedi `buildProjectRuleset`).
       *
       * Prima il perimetro si riconosceva dalla FORMA del ruleset (cercando un
       * deny su external_directory): un confine espresso in modo diverso — o
       * anche solo un `ask` al posto del `deny` — non veniva riconosciuto, e
       * tutti i filtri di `evaluate` saltavano in silenzio. Il confine e' una
       * proprieta' della REGOLA, dichiarata da chi la emette, non dedotta da
       * chi la legge. Opzionale per compatibilita': i ruleset scritti prima
       * continuano a leggersi.
       */
      boundary: z.boolean().optional(),
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
   * Un confine e' presente nel ruleset? Si cerca il MARCATORE ESPLICITO emesso
   * da `buildProjectRuleset`, non la forma del ruleset.
   *
   * Prima si riconosceva il perimetro cercando un `deny` su external_directory:
   * un confine espresso in modo diverso (o anche solo con `ask` al posto del
   * `deny`) non veniva riconosciuto, e TUTTI i filtri saltavano in silenzio —
   * il confine restava apparentemente in piedi mentre l'`always` lo svuotava.
   */
  function isPerimeter(ruleset: Ruleset): boolean {
    return ruleset.some((r) => r.boundary === true)
  }

  /**
   * Una concessione `allow` che NON deve partecipare alla valutazione, perche'
   * annullerebbe un confine invece di applicarlo.
   *
   * La proprieta' che conta e' la PROVENIENZA, non la forma del pattern. Il
   * primo tentativo cercava i pattern "che coprono tutto" (`coversEverything`):
   * era una euristica indecidibile, e sbagliava in modo silenzioso —
   * `Wildcard.match("*", "?????*")` e' false, ma `?????*` diventa `^.{5,}$` e
   * copre comunque `/etc/passwd`, quindi un `allow` con quel pattern scavalcava
   * il deny. Non si indovina: si distingue chi ha emesso la regola.
   *
   * - Le `allow` del confine stesso (`boundary: true`, emesse da
   *   `buildProjectRuleset` per i path DENTRO il progetto) restano.
   * - Una `allow` da un altro canale (click "sempre", DB `approved`, config)
   *   su un'area che il confine NEGA non entra: e' esattamente il caso
   *   `{edit, /etc/*, allow}` che apriva tutto, e sotto un confine una
   *   concessione su un'area negata e' o ridondante (se interna, il confine la
   *   concede gia') o un buco (se esterna).
   * - FAMIGLIA su una permission a testo di comando: `python3 *` copre
   *   `python3 -c "open('/etc/x','w')"`. La classificazione dei comandi (che
   *   decide se chiedere) viene saltata quando il permesso e' gia' concesso,
   *   quindi la famiglia non puo' diventare permanente. Il COMANDO ESATTO si':
   *   e' gia' confinato per costruzione (i path esterni sono risolti prima).
   *
   * Il filtro si applica SOLO alle permission di `FILTERABLE`: fuori da quelle
   * aree il ruleset resta una preferenza dell'utente e "l'ultima regola vince".
   *
   * `bound` e' il path assoluto in valutazione: serve a `boundaryDenies` per
   * confrontare la copertura del deny con il path che la concessione aprirebbe.
   * Una regola senza path (permission a testo di comando) lo riceve come "".
   */
  function voidsBoundary(rule: Rule, merged: Ruleset, bound: string): boolean {
    if (rule.action !== "allow") return false

    // I casi valgono SOLO in una sessione perimetrata.
    if (!isPerimeter(merged)) return false

    // Le concessioni del confine stesso non si filtrano: sono il confine.
    if (rule.boundary === true) return false

    if (!isFilterable(rule.permission)) return false

    if (isCommandPermission(rule.permission) && hasWildcard(rule.pattern)) return true

    if (boundaryDenies(rule.permission, merged, bound)) return true

    return false
  }

  /**
   * Il confine nega un PATH, non un'AREA. Una `deny` del confine copre solo i
   * path che il suo pattern tocca: se il confine consente esplicitamente
   * `/tmp` per gli strumenti di scansione, un `deny` su `edit` con pattern `/etc/*`
   * non deve cancellare le concessioni su `/tmp`.
   *
   * Percio' `deny` e' confrontata per AREA *e* per COPERTURA DEL PATH: una
   * concessione viene filtrata solo se il confine nega davvero il path che
   * quella concessione aprirebbe. `bound` e' il path assoluto in valutazione,
   * non il pattern della regola: i due hanno forme diverse (relativa per
   * `edit`, assoluta per `external_directory`) e vanno normalizzati allo stesso
   * modo prima di confrontarli.
   */
  function boundaryDenies(permission: string, merged: Ruleset, bound: string): boolean {
    return merged.some(
      (r) => r.boundary === true && r.action === "deny" && sameArea(permission, r.permission) && covers(r, bound),
    )
  }

  /**
   * Il pattern del confine copre questo path?
   *
   * Il deny del confine copre TUTTO quello che puo' coprire se ha un jolly
   * (`*`, che e' il caso di `buildProjectRuleset`). Senza jolly, il confronto e'
   * letterale sul pattern e sul path **nello stesso spazio**: un deny relativo
   * (`bugbounty/*`, relativo al worktree) e' confrontato con il relativo della
   * regola, non con il suo path assoluto — altrimenti non coprirebbe mai nulla,
   * che e' la metà del difetto che questo fix chiude.
   */
  function covers(rule: Rule, bound: string): boolean {
    if (hasWildcard(rule.pattern)) return true
    return Wildcard.match(bound, rule.pattern)
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
   *
   * Il confronto e' per AREA (`Wildcard.match`), non per uguaglianza: un
   * `{bash*, *, allow}` scavalcava il controllo perche' il Set non contiene
   * esattamente "bash*", e apriva `bash` E `bash_unresolved`.
   */
  const COMMAND_PERMISSIONS = ["bash", "bash_unresolved"]

  /**
   * Due nomi di permission si riferiscono alla stessa area? Il confronto è
   * BIDIREZIONALE: una regola può nominare l'area con un jolly (`bash*`, la
   * forma che `fromConfig` emette) e l'area può essere nominata esattamente
   * (`bash`). Con una sola direzione `{bash*, *, allow}` non veniva riconosciuto
   * come appartenente all'area `bash` e scavalcava il confine.
   */
  function sameArea(a: string, b: string): boolean {
    return Wildcard.match(a, b) || Wildcard.match(b, a)
  }

  function isCommandPermission(permission: string): boolean {
    return COMMAND_PERMISSIONS.some((p) => sameArea(permission, p))
  }

  /**
   * Permission che il filtro puo' toccare. Il filtro NON e' un meccanismo
   * generale: esiste per difendere un confine di scrittura, e fuori da quelle
   * aree ucciderebbe concessioni legittime. E' successo per davvero: l'override
   * `{question: "allow"}` di `agent.ts` veniva filtrato quando il ruleset
   * conteneva un deny su `question` (default dell'agente), e il tool `question`
   * restava morto con DeniedError.
   *
   * E' un'ALLOWLIST: un'area nuova non e' filtrata finche' non viene aggiunta,
   * quindi un errore qui non riapre il confine in silenzio.
   */
  const FILTERABLE = ["edit", "write", "patch", "multiedit", "external_directory", ...COMMAND_PERMISSIONS]

  function isFilterable(permission: string): boolean {
    return FILTERABLE.some((p) => sameArea(permission, p))
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
          voidsBoundary(
            { permission: existing.info.permission, pattern, action: "allow" },
            existing.ruleset,
            path.isAbsolute(pattern) ? pattern : path.resolve(Instance.worktree, pattern),
          ),
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
    // Il deny del confine va confrontato con il PATH che la regola aprirebbe.
    // Il pattern in valutazione e' relativo per `edit` (i tool mandano
    // `path.relative(worktree)`) e assoluto per `external_directory`: nei due
    // casi i confronti avvengono nello spazio giusto, e non serve normalizzare.
    // La normalizzazione non legge `Instance`: `evaluate` resta pura, e
    // introdurre qui una lettura dello stato globale cambierebbe il suo
    // risultato in una funzione che dipende da dove e' stata chiamata.
    const assoluto = pattern
    const effective = merged.filter((rule) => !voidsBoundary(rule, merged, assoluto))
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
