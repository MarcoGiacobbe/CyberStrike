/**
 * Il contesto di hunting: cosa dice all'agente chi è, dove può andare e cosa
 * ha già fatto. `bb hunt` non inventa niente qui — mette in fila dati che esistono
 * gia' (config del programma, stato del progetto) in un solo testo, cosi' l'agente
 * non deve andare a leggerli uno per uno e puo' sbagliare di meno.
 */
import { BountyState } from "./bounty-state"

/** I dati che servono al messaggio, presi dal config e dallo stato. */
export namespace HuntContext {
  export const TITLE = "Bug bounty hunting"

  /**
   * Il testo che apre la sessione. Nessun LLM, nessuna rete: solo testo
   * costruito dai dati, cosi' `--dry-run` e' verificabile da solo e l'agente
   * parte gia' orientato.
   *
   * `state` e' opzionale perche' un programma appena creato non ha ancora
   * `state.json`: in quel caso non e' un errore, e' il bootstrap.
   */
  export function message(input: {
    program: string
    directory: string
    config?: {
      description?: string
      scope?: { in?: string[]; out?: string[] }
      payouts?: Record<string, string>
      rules?: { maxSteps?: number; authenticated?: boolean }
      headerName?: string
      h1Username?: string
      uaTemplate?: string
    }
    state?: BountyState.Info
    /** true se il config del programma non esiste ancora: non e' sincronizzato.
     *  Il file reale e' `<handle>.json` nella root bug bounty, NON `program.json`
     *  dentro la directory (misurato il 2026-09-29: `program.json` non compare
     *  in nessun punto di src/, e la directory `program` che `bb hunt` creava
     *  dentro la cartella del programma non era letta da nessuno). */
    unsynced?: boolean
    /** fatto, non interpretazione: la directory di progetto esiste gia' su disco */
    existed?: boolean
    /** true se il programma e' stato rimosso con `bb remove` ma la directory c'e' */
    orphan?: boolean
    /**
     * Il sync automatico e' fallito e si sta proseguendo con i dati di prima.
     * Va NEL MESSAGGIO, non solo a terminale: se l'agente produce un report
     * su uno scope invecchiato il report viene respinto, quindi e' l'agente
     * — non l'utente — la prima cosa che deve sapere che quei dati non
     * sono freschi. Testo pronto, gia' scritto da `bb-sync-freshness`.
     */
    stale?: string
  }): string {
    const out: string[] = []
    const cfg = input.config

    out.push(`# Bug bounty hunting — ${input.program}`)
    out.push("")
    out.push(
      `Directory di lavoro: \`${input.directory}\`${
        input.existed ? "" : " (non ancora creata)"
      }`,
    )
    out.push(
      "Sei dentro il perimetro di questo progetto: puoi leggere ovunque, scrivere solo qui dentro.",
    )
    out.push("")

    // L'avviso di dati non freschi va per primo, prima di scope e payout: se
    // non sono aggiornati, tutto cio' che segue va letto con quel dubbio.
    if (input.stale) {
      out.push(input.stale)
      out.push("")
    }

    // I due avvisi sono mutuamente esclusivi: "rimosso" È il caso peggiore di
    // "non sincronizzato" (config assente + directory presente). Stamparli
    // insieme diceva due cose contraddittorie. Misurato il 2026-09-26.
    if (input.unsynced && input.orphan) {
      out.push(
        "> **Attenzione: programma rimosso.** La directory di questo progetto esiste, ma il programma non e' piu' " +
          "in elenco (è stato rimosso con `bb remove`). Il lavoro precedente resta, ma nessun target e' piu' in scope.",
      )
      out.push("")
    } else if (input.unsynced) {
      out.push(
        `> **Programma non sincronizzato.** I dati del programma (scope, regole, payout) ` +
          `non sono in disco: quello che leggi sotto e' quello che c'era all'ultimo salvataggio, ` +
          `potrebbe essere vecchio o mancante. Prima di toccare un target verifica con ` +
          `\`bb info ${input.program}\` e, se i dati non bastano, chiedi all'utente di lanciare ` +
          `\`bb sync ${input.program}\`.`,
      )
      out.push("")
    }

    if (cfg?.description) {
      out.push("## Programma")
      out.push(cfg.description)
      out.push("")
    }

    const inScope = cfg?.scope?.in ?? []
    const outScope = cfg?.scope?.out ?? []

    if (inScope.length > 0) {
      out.push("## Scope IN")
      for (const t of inScope) out.push(`- ${t}`)
      out.push("")
    } else if (!input.unsynced) {
      out.push("## Scope IN")
      out.push("- (nessun target in scope — controlla con `bb info " + input.program + "`)")
      out.push("")
    }

    if (outScope.length > 0) {
      out.push("## Scope OUT — NON toccare")
      for (const t of outScope) out.push(`- ${t}`)
      out.push("")
    }

    if (cfg?.payouts && Object.keys(cfg.payouts).length > 0) {
      out.push("## Payout")
      for (const [k, v] of Object.entries(cfg.payouts)) out.push(`- ${k}: ${v}`)
      out.push("")
    }

    if (cfg?.rules) {
      out.push("## Regole del programma")
      if (cfg.rules.maxSteps) out.push(`- max steps: ${cfg.rules.maxSteps}`)
      if (cfg.rules.authenticated) out.push("- serve autenticazione")
      out.push("")
    }

    if (cfg?.headerName) {
      out.push("## Header richiesto")
      out.push(
        `- \`${cfg.headerName}\` va impostato PRIMA di qualsiasi richiesta al target, e nel modo in cui il programma ` +
          `lo chiede. È la prima cosa da fare quando si avvia un programma.`,
      )
      if (cfg.h1Username) out.push(`- valore: \`${cfg.h1Username}\``)
      if (cfg.uaTemplate) out.push(`- User-Agent: \`${cfg.uaTemplate}\``)
      out.push("")
    }

    if (input.state) {
      const s = input.state
      out.push("## Stato del progetto")
      out.push(`- fase: \`${s.phase}\``)
      out.push(`- aggiornato: ${s.updatedAt}`)
      out.push(`- target toccati: ${s.targets.length}`)
      if (s.targets.length > 0) {
        for (const t of s.targets) out.push(`  - ${t.host}`)
      }
      const f = s.findings
      out.push(
        `- finding: ${f.total} totali, ${f.approved} approvati, ${f.new} nuovi`,
      )
      if (s.phase === "paused") {
        out.push("- il lavoro è in pausa: chiedi prima di riprendere")
      }
      out.push("")
    }

    out.push("## Cosa ti aspetti")
    out.push(
      "Se non ti dico altrimenti, parti dal recon sui target in scope e riferisci quello che hai trovato. " +
        "Non uscire dal perimetro e non toccare niente in scope OUT.",
    )

    return out.join("\n")
  }

  /** Una riga per `--dry-run`: come sta il progetto, in una frase. */
  export function summary(state?: BountyState.Info): string {
    if (!state) return "nessuno stato (progetto nuovo)"
    const f = state.findings
    return (
      `fase ${state.phase}, ${state.targets.length} target toccati, ` +
      `${f.total} finding (${f.approved} approvati), aggiornato ${state.updatedAt}`
    )
  }
}
