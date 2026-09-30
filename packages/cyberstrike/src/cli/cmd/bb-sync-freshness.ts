/**
 * Quando `bb hunt` deve sincronizzare da solo.
 *
 * La scelta — non a ogni avvio, ma solo se i dati hanno piu' di 24 ore —
 * merita una riga di perche', altrimenti il prossimo che legge il codice
 * la semplifica in "sync a ogni avvio" e non sa cosa sta rompendo:
 *
 *   - il TUI e' un processo da ~800 MB e l'avvio costa piu' del sync;
 *   - `bb hunt` su un programma gia' fresco NON deve dipendere dalla rete:
 *     se la rete e' assente l'avvio deve comunque funzionare, perche' i
 *     dati che gia' ci sono bastano a partire;
 *   - `--force` aggiorna quando serve, senza aspettare le 24 ore.
 *
 * E' la stessa regola che si ha davanti agli occhi con npm, docker o un
 * pacchetto pip: contenuto gia' presente e fresco non si riscarica da capo.
 */

/** Ore oltre le quali i dati di un programma si considerano vecchi. */
export const DEFAULT_MAX_AGE_HOURS = 24

/**
 * Ore trascorse da `lastUpdated`, o `null` se il dato non e' utilizzabile.
 *
 * `null` non e' "fresco": un programma che non e' mai stato sincronizzato, o
 * con una `lastUpdated` illeggibile, ha bisogno del sync. Restituirlo come 0
 * (cioe' "appena aggiornato") farebbe partire l'agente con scope mancante.
 */
export function ageHours(lastUpdated: string | null | undefined, now: number = Date.now()): number | null {
  if (!lastUpdated) return null
  const t = Date.parse(lastUpdated)
  if (Number.isNaN(t)) return null
  // Una data nel futuro non e' "freschissima": e' un dato corrotto. La
  // trattiamo come vecchia cosi' il sync la riscrive invece di fidarsi.
  if (t > now) return Number.POSITIVE_INFINITY
  return (now - t) / 3_600_000
}

/**
 * `bb hunt` deve lanciare il sync prima di aprire la sessione?
 *
 * @param etaOre  ore trascorse da `lastUpdated`; `null` = mai sincronizzato
 * @param maxOre  soglia oltre la quale si sincronizza
 * @param force   `--force`: sincronizza comunque, l'eta' non conta
 */
export function needsSync(etaOre: number | null, maxOre: number = DEFAULT_MAX_AGE_HOURS, force = false): boolean {
  if (force) return true
  if (etaOre === null) return true
  return etaOre > maxOre
}

/**
 * Il messaggio all'utente: quando i dati sono vecchi ma il sync e' fallito,
 * l'avvio continua e DICHIARA che cosa sta usando. Non e' decorativo: se
 * l'agente lavora su uno scope invecchiato e produce un report, il report
 * viene respinto — quindi la riga deve arrivare anche nel prompt dell'agente,
 * non solo a terminale.
 */
export function staleNotice(program: string, etaOre: number | null, err?: unknown): string | undefined {
  if (err === undefined) return undefined
  const quando =
    etaOre === null
      ? "nessuna data di sincronizzazione"
      : Number.isFinite(etaOre)
        ? `${Math.floor(etaOre / 24)} giorni fa`
        : "data di sincronizzazione nel futuro (dato corrotto)"
  return (
    `> ⚠ non ho potuto aggiornare i dati di ${program}: ${err instanceof Error ? err.message : String(err)}\n` +
    `> uso quelli dell'ultimo salvataggio — ${quando}. Non fidarti dello scope: ` +
    `prima di toccare un target, digli all'utente di lanciare \`bb sync ${program}\`.`
  )
}
