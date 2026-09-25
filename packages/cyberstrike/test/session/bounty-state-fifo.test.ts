import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BountyState } from "../../src/session/bounty-state"

/**
 * V9/D5 — una `state.json` che è una FIFO bloccherebbe il processo per sempre.
 *
 * Il test è racchiuso in un timeout deliberato: se la difesa è spenta,
 * `readFileSync` sulla named pipe si appende e il test deve MORIRE, non
 * trascinare l'intera suite. Un test che si blocca è esso stesso il difetto.
 */
describe("V9/D5 — una FIFO come state.json non blocca", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "v9-fifo-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("read() rifiuta la FIFO invece di appendersi", () => {
    execSync(`mkfifo ${path.join(dir, "state.json")}`)

    // Se la difesa è spenta, questa riga non ritorna mai.
    expect(() => BountyState.read(dir)).toThrow(/non e' un file leggibile/)
  }, 10_000)

  test("la FIFO viene trattata come «presente ma rotta», non come assente", () => {
    // La distinzione conta: "assente" verrebbe sovrascritto con `idle`,
    // cancellando la fase dichiarata — l'esatto buco di B1.
    execSync(`mkfifo ${path.join(dir, "state.json")}`)

    let err: any
    try {
      BountyState.read(dir)
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    expect(err.message).not.toContain("nessun state.json")
  }, 10_000)

  test("la FIFO non viene sovrascritta da refresh()", () => {
    execSync(`mkfifo ${path.join(dir, "state.json")}`)

    try {
      BountyState.refresh(dir)
    } catch {
      /* il rifiuto è il comportamento atteso */
    }
    // La named pipe deve essere ancora la: nessuna sovrascrittura "riparata".
    const st = fs.lstatSync(path.join(dir, "state.json"))
    expect(st.isFIFO()).toBe(true)
  }, 10_000)
})
