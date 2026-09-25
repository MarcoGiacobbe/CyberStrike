import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { Instance } from "../../src/project/instance"
import { BountyState } from "../../src/session/bounty-state"

// Test dello stato di progetto (ticket stato-progetto).
// Coprono: schema versionato, scrittura atomica, derivazione dei fatti dal DB,
// riconoscimento del progetto di hunting, gate di todowrite.

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounty-state-"))
  return dir
}

/** Una directory che sembra un progetto di hunting, sotto bugbounty/programs/. */
function huntingDir(): string {
  const base = tmpdir()
  const dir = path.join(base, "bugbounty", "programs", "acme")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe("stato di progetto — schema e persistenza", () => {
  test("create produce uno stato valido e leggibile", () => {
    const dir = huntingDir()
    const info = BountyState.create({ directory: dir, program: "acme" })
    BountyState.write(info)

    const back = BountyState.read(dir)
    expect(back.program).toBe("acme")
    expect(back.phase).toBe("idle")
    expect(back.version).toBe(BountyState.VERSION)
    expect(back.targets).toEqual([])
    expect(back.findings.total).toBe(0)
  })

  test("read su directory senza stato lancia Unreadable, non restituisce null", () => {
    // La distinzione conta: "non c'è" si crea, "c'è ed è rotto" si segnala.
    const dir = tmpdir()
    expect(() => BountyState.read(dir)).toThrow(BountyState.Unreadable)
    expect(BountyState.exists(dir)).toBe(false)
  })

  test("uno stato con versione sconosciuta è RIFIUTATO, non reinterpretato", () => {
    const dir = huntingDir()
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 999, program: "acme" }))
    expect(() => BountyState.read(dir)).toThrow(/versione dello stato/)
    expect(BountyState.exists(dir)).toBe(false)
  })

  test("uno stato con JSON non valido è rifiutato", () => {
    const dir = huntingDir()
    fs.writeFileSync(path.join(dir, "state.json"), "{ questo non è json")
    expect(() => BountyState.read(dir)).toThrow(/JSON non valido/)
  })

  test("uno stato che non rispetta lo schema è rifiutato", () => {
    const dir = huntingDir()
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ version: BountyState.VERSION, directory: dir, program: "acme" }), // manca phase
    )
    expect(() => BountyState.read(dir)).toThrow(/schema non valido/)
  })

  test("la scrittura è atomica: nessun .tmp residuo", () => {
    const dir = huntingDir()
    const info = BountyState.create({ directory: dir, program: "acme" })
    BountyState.write(info)
    BountyState.write({ ...info, phase: "recon" })

    const files = fs.readdirSync(dir)
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([])
    expect(BountyState.read(dir).phase).toBe("recon")
  })

  test("lo stato è scritto con permessi owner-only", () => {
    const dir = huntingDir()
    BountyState.write(BountyState.create({ directory: dir, program: "acme" }))
    const mode = fs.statSync(path.join(dir, "state.json")).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("setPhase aggiorna la fase e non tocca i fatti derivati", () => {
    const dir = huntingDir()
    BountyState.write(BountyState.create({ directory: dir, program: "acme" }))
    const next = BountyState.setPhase(dir, "testing")
    expect(next.phase).toBe("testing")
    expect(next.targets).toEqual([])
  })

  test("setPhase su stato inesistente lancia (nessuno stato implicito)", () => {
    const dir = tmpdir()
    expect(() => BountyState.setPhase(dir, "recon")).toThrow(BountyState.Unreadable)
  })
})

describe("stato di progetto — riconoscimento del progetto di hunting", () => {
  test("una directory sotto bugbounty/programs/ è un progetto di hunting", () => {
    expect(BountyState.isHuntingDir(huntingDir())).toBe(true)
  })

  test("una directory con state.json è un progetto di hunting (anche fuori dal layout)", () => {
    const dir = tmpdir()
    BountyState.write(BountyState.create({ directory: dir, program: "x" }))
    expect(BountyState.isHuntingDir(dir)).toBe(true)
  })

  test("una directory qualunque NON è un progetto di hunting", () => {
    expect(BountyState.isHuntingDir(tmpdir())).toBe(false)
  })

  test("il progetto appena creato è riconosciuto anche PRIMA che lo state.json esista", () => {
    // Conta perché bb hunt apre la sessione su un progetto nuovo: se il
    // riconoscimento dipendesse dal file, il gate non scatterebbe proprio
    // quando serve di più.
    const dir = path.join(tmpdir(), "bugbounty", "programs", "fresco")
    fs.mkdirSync(dir, { recursive: true })
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(false)
    expect(BountyState.isHuntingDir(dir)).toBe(true)
  })

  test("la directory 'programs' stessa non è un progetto", () => {
    const dir = path.join(tmpdir(), "bugbounty", "programs")
    fs.mkdirSync(dir, { recursive: true })
    expect(BountyState.isHuntingDir(dir)).toBe(false)
  })
})

describe("stato di progetto — hostOf normalizza l'asset in host", () => {
  test("URL con schema → host", () => {
    expect(BountyState.hostOf("https://app.example.com/api/x")).toBe("app.example.com")
    expect(BountyState.hostOf("http://example.com:8443/x?y=1")).toBe("example.com:8443")
  })

  test("host nudo, con porta o path → host", () => {
    expect(BountyState.hostOf("example.com")).toBe("example.com")
    expect(BountyState.hostOf("example.com:443")).toBe("example.com:443")
    expect(BountyState.hostOf("example.com/path")).toBe("example.com")
    expect(BountyState.hostOf("*.example.com")).toBe("*.example.com")
  })

  test("un asset non riconosciuto si tiene com'è (meglio grezzo che perso)", () => {
    expect(BountyState.hostOf("arn:aws:s3:::my-bucket")).toBe("arn:aws:s3:::my-bucket")
  })

  test("la normalizzazione è case-insensitive sull'host", () => {
    expect(BountyState.hostOf("HTTPS://APP.Example.COM/x")).toBe("app.example.com")
  })
})

describe("stato di progetto — flag di sessione (il gate di todowrite)", () => {
  test("una sessione nuova NON ha caricato lo stato", async () => {
    const dir = huntingDir()
    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = "ses_" + Math.random().toString(36).slice(2)
        expect(BountyState.loaded(sid)).toBe(false)
      },
    })
  })

  test("dopo load la sessione risulta caricata, e il flag è per-sessione", async () => {
    const dir = huntingDir()
    await Instance.provide({
      directory: dir,
      fn: async () => {
        const a = "ses_" + Math.random().toString(36).slice(2)
        const b = "ses_" + Math.random().toString(36).slice(2)
        BountyState.load(a, dir, "acme")
        expect(BountyState.loaded(a)).toBe(true)
        // il flag NON è globale: un'altra sessione resta da caricare
        expect(BountyState.loaded(b)).toBe(false)
      },
    })
  })

  test("il flag si può azzerare (solo per i test)", async () => {
    const dir = huntingDir()
    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = "ses_" + Math.random().toString(36).slice(2)
        BountyState.markLoaded(sid)
        expect(BountyState.loaded(sid)).toBe(true)
        BountyState.unmarkLoaded(sid)
        expect(BountyState.loaded(sid)).toBe(false)
      },
    })
  })
})