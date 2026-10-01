/**
 * "Programma inesistente" non e' "dati vecchi".
 *
 * La Fase 2 ha stabilito che una rete assente non blocca l'avvio: si parte con
 * i dati precedenti e lo si dichiara. Bene, ma quel comportamento nasconde un
 * caso diverso: se il PROGRAMMA non esiste — nome sbagliato, programma
 * rinominato, programma chiuso — partire con uno scope inesistente non e' un
 * fallback, e' un errore di input. L'agente produrrebbe finding su target che
 * non esistono e l'utente scoprirebbe di aver speso ore su un nome sbagliato
 * solo quando il report viene respinto.
 *
 * La classificazione e' qui, non nel chiamante, perche' lo stesso fatto arriva
 * da due punti diversi con due testi diversi:
 *   - sync.ts, quando `team` e' null -> "Program 'x' not found on HackerOne"
 *   - GraphQL, quando il team non c'e' -> "Team does not exist"
 * Grappolarsi sul testo significa che un refactor del messaggio upstream
 * rimette in gioco il TUI su un programma inesistente. Il tipo e' il segnale.
 */

export class ProgramNotFoundError extends Error {
  readonly handle: string
  constructor(handle: string) {
    super(`Program '${handle}' not found on HackerOne`)
    this.name = "ProgramNotFoundError"
    this.handle = handle
  }
}

/**
 * Testi conosciuti che descrivono l'assenza del programma e NON un problema di
 * rete. Elencati perche' misurati, non perche' presunti: i due qui sotto sono
 * quello che arriva davvero da GraphQL quando il team non esiste.
 *
 * Nota di manutenzione: se GraphQL cambia il messaggio, la lista va aggiornata
 * qui — non spostata nel chiamante. Chi lo tocca deve aggiungere anche il caso
 * al test, altrimenti un programma inesistente riparte in silenzio.
 */
const MISSING_PROGRAM_HINTS = [
  "not found on hackerone",
  "team does not exist",
  "does not exist",
  "unknown team",
  "no team",
]

/**
 * True solo per l'assenza del programma.
 *
 * Falso per TUTTO il resto, e il default e' falso perche' il costo dei due
 * errori e' opposto: scambiando un errore di rete per "inesistente" si fa
 * fallire un avvio che poteva partire; scambiando "inesistente" per rete si
 * lascia partire un agente su scope fantasma. Il secondo e' peggiore, quindi
 * in caso di dubbio si lascia partire — ma solo se il programma ESISTE gia' in
 * locale, condizione che il chiamante controlla a parte.
 */
export function isProgramMissing(error: unknown): boolean {
  if (error instanceof ProgramNotFoundError) return true
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return MISSING_PROGRAM_HINTS.some((h) => msg.includes(h))
}
