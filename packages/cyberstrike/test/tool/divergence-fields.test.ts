import { describe, expect, test } from "bun:test"
import { BountyState } from "../../src/session/bounty-state"

// `divergences()` confrontava i target solo per NUMERO di sessioni e non
// confrontava `lastSeen`. Un target con 40 sessioni inventate — stesso numero,
// id inesistenti — passava come conforme, e una `lastSeen` del 1999 passava
// come conforme. Il commento nel codice prometteva il contrario ("un
// `sessions: 40` con id inesistenti, o un `firstSeen` che precede ogni
// evidenza, è altrettanto falso"): il codice non lo faceva.
//
// Questi test sono rossi a HEAD.

const target = (over: Partial<BountyState.Target> = {}): BountyState.Target => ({
  host: "app.example",
  firstSeen: "2026-01-01T00:00:00.000Z",
  lastSeen: "2026-01-02T00:00:00.000Z",
  sessions: ["ses_reale"],
  ...over,
})

const findings = { total: 0, new: 0, approved: 0, duplicate: 0, other: 0 }

function stateWith(targets: BountyState.Target[]): BountyState.Info {
  return { ...BountyState.create({ directory: "/x", program: "p" }), targets } as BountyState.Info
}

function derivedWith(targets: BountyState.Target[]) {
  return { targets, findings }
}

describe("divergences — confronto COMPLETO dei campi di prova", () => {
  test("ID di sessione inventati: stesso numero, contenuto falso", () => {
    const out = BountyState.divergences(
      stateWith([target({ sessions: ["ses_INVENTATO"] })]),
      derivedWith([target()]),
    )
    expect(out.length).toBeGreaterThan(0)
    expect(out.join(" ")).toContain("ses_INVENTATO")
  })

  test("lastSeen falsificata: stessa coppia di sessioni", () => {
    const out = BountyState.divergences(
      stateWith([target({ lastSeen: "1999-01-01T00:00:00.000Z" })]),
      derivedWith([target()]),
    )
    expect(out.length).toBeGreaterThan(0)
    expect(out.join(" ")).toContain("lastSeen")
  })

  test("firstSeen falsificata era gia' confrontata: resta una divergenza", () => {
    // Control-lo: il caso che il codice GIA' gestiva. Serve a non sostituire un
    // confronto vero con uno che perde il campo buono insieme a quello rotto.
    const out = BountyState.divergences(
      stateWith([target({ firstSeen: "1999-01-01T00:00:00.000Z" })]),
      derivedWith([target()]),
    )
    expect(out.length).toBeGreaterThan(0)
  })

  test("l'ORDINE delle sessioni NON e' un fatto: stessa lista riordinata e' conforme", () => {
    // La distinzione che tiene insieme i due casi: gli ID contano come INSIEME
    // (quale sessione ha toccato il target), non come sequenza (in che ordine
    // sono arrivate). Riordinare non cambia il fatto.
    const d = derivedWith([target({ sessions: ["ses_a", "ses_b"] })])
    const out = BountyState.divergences(stateWith([target({ sessions: ["ses_b", "ses_a"] })]), d)
    expect(out).toEqual([])
  })

  test("stato perfettamente conforme: nessuna divergenza", () => {
    const t = target({ sessions: ["ses_a", "ses_b"] })
    const out = BountyState.divergences(stateWith([t]), derivedWith([t]))
    expect(out).toEqual([])
  })
})
