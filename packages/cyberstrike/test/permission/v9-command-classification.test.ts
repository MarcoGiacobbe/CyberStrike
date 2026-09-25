import { describe, expect, test } from "bun:test"
import { ProjectPerimeter, classify, pathCandidates } from "../../src/permission/project"

/**
 * Regressioni V9. Ogni test qui sotto deve FALLIRE con la difesa spenta: una
 * difesa senza controprova non e' una difesa.
 */
describe("V9/G1 — `env` è un wrapper, non un lettore", () => {
  test("env non è più classificato read-only", () => {
    // Difesa spenta: `env` era in READ_ONLY, quindi pathCandidates non veniva
    // nemmeno chiamato e `env touch /tmp/x` non produceva alcuna richiesta.
    expect(classify("env")).toBe("write")
  })

  test("i path di `env CMD ARGS` vengono raccolti", () => {
    const c = pathCandidates("env", ["env", "touch", "/tmp/x"])
    expect(c).toContain("/tmp/x")
  })

  test("`env` senza argomenti non inventa path", () => {
    // `env` da solo stampa l'ambiente: nessun path da sorvegliare.
    const c = pathCandidates("env", ["env"])
    expect(c).not.toContain("/tmp/x")
  })
})

describe("V9/D10 — i flag accorpati introducono un path", () => {
  test("curl -o/tmp/x (accorpato)", () => {
    // Difesa spenta: `arg === f` non riconosceva `-o/tmp/x`.
    expect(pathCandidates("curl", ["curl", "-o/tmp/x"])).toContain("/tmp/x")
  })

  test("curl --output=/tmp/x (forma lunga con =)", () => {
    expect(pathCandidates("curl", ["curl", "--output=/tmp/x"])).toContain("/tmp/x")
  })

  test("wget -O/tmp/x (maiuscolo)", () => {
    expect(pathCandidates("wget", ["wget", "-O/tmp/x"])).toContain("/tmp/x")
  })

  test("tar -C/tmp/d", () => {
    expect(pathCandidates("tar", ["tar", "-C/tmp/d"])).toContain("/tmp/d")
  })

  test("la forma normale continua a funzionare", () => {
    expect(pathCandidates("curl", ["curl", "-o", "/tmp/x"])).toContain("/tmp/x")
  })

  test("un flag booleano non viene scambiato per un path", () => {
    // `-sS` è un flag: non deve diventare candidato. `https://x` invece lo è
    // (argomento posizionale: tutti i posizionali sono candidati per contratto),
    // quindi il confronto va fatto sul flag, non sull'URL.
    const c = pathCandidates("curl", ["curl", "-sS", "https://x"])
    expect(c).not.toContain("-sS")
  })

  test("un flag accorpato col nome di un path flag non produce un path", () => {
    // `-output` non è `-o` accorpato: la forma lunga usa `=`, non l'accorciamento.
    // Difensivo: se un giorno `isAttachedFlag` accettasse questo, comparirebbe
    // `utput` come candidato.
    const c = pathCandidates("curl", ["curl", "-output/tmp/x"])
    expect(c).not.toContain("utput")
  })

  test("`--output` senza valore non produce path", () => {
    // niente dopo `=`: nessun path, nessun candidato.
    const c = pathCandidates("curl", ["curl", "--output="])
    expect(c).not.toContain("")
  })
})
