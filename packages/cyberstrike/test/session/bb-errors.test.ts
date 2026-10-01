import { describe, expect, test } from "bun:test"
import { ProgramNotFoundError, isProgramMissing } from "../../src/session/bb-errors"

/**
 * Perche' questo modulo esiste.
 *
 * Fino alla Fase 2 la caduta era: rete assente -> si parte con i dati vecchi.
 * Corretto, ma nasconde un caso che non e' "dati vecchi": il PROGRAMMA NON
 * ESISTE. Se l'utente scrive male il nome, o il programma e' stato rinominato
 * o chiuso, l'agente parte con scope inesistente e riempirà di report che
 * nessuno puo' accettare. Non e' un fallback: e' un errore di input.
 *
 * Non si distingue dal testo dell'errore perche' lo stesso fatto arriva da
 * due punti diversi:
 *   - `sync.ts:103`  -> "Program 'x' not found on HackerOne"
 *   - GraphQL        -> "Team does not exist"
 * Se si grappolasse sul testo, bastava un refactor del messaggio upstream per
 * far ripartire il TUI su un programma inesistente. Per questo la decisione
 * si prende in `sync.ts`, dove si sa che `team` e' null, e viaggia come
 * errore TIPIZZATO.
 */

describe("programma inesistente: errore, non fallback", () => {
  test("il modulo espone un errore tipizzato, non una stringa da cercare", () => {
    const e = new ProgramNotFoundError("fantasma")
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe("ProgramNotFoundError")
    expect(e.handle).toBe("fantasma")
  })

  test("'not found' e 'Team does not exist' sono lo stesso difetto", () => {
    // I due testi arrivano da due posti diversi ma descrivono lo stesso fatto.
    // Se un domani il messaggio GraphQL cambia, la classificazione non deve
    // cambiare con lui: e' il tipo a dire cosa sia.
    expect(isProgramMissing(new ProgramNotFoundError("x"))).toBe(true)
    expect(isProgramMissing(new Error("Program 'x' not found on HackerOne"))).toBe(true)
    expect(isProgramMissing(new Error("HackerOne GraphQL: Team does not exist"))).toBe(true)
  })

  test("un errore di rete NON e' un programma inesistente", () => {
    // Questa e' la riga che protegge il fallback della Fase 2: se una
    // connessione assente venisse classificata come "programma inesistente",
    // si perderebbe il comportamento che l'utente ha approvato.
    const rete = [
      new Error("HackerOne GraphQL HTTP 503"),
      new Error("HackerOne GraphQL: empty data"),
      new Error("fetch failed"),
      new Error("connection timed out"),
      new Error("ECONNREFUSED"),
    ]
    for (const e of rete) {
      expect(isProgramMissing(e)).toBe(false)
    }
  })

  test("nessun errore di rete viene scambiato per 'programma inesistente'", () => {
    // Il viceversa e' il caso peggiore: un errore di rete che passa per
    // programma inesistente fa fallire l'avvio quando si poteva partire.
    const testo = "HackerOne GraphQL: Failed to fetch"
    expect(isProgramMissing(new Error(testo))).toBe(false)
  })
})
