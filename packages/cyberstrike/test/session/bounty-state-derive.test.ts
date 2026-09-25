import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { Instance } from "../../src/project/instance"
import { BountyState } from "../../src/session/bounty-state"
import { Session } from "../../src/session"
import { CoverageNote } from "../../src/session/coverage-note"

// La derivazione (pull): i fatti nello stato NON si scrivono a mano, si leggono
// dall'evidenza. Qui si verifica che i "target toccati" e i "findings" vengano
// davvero dalle coverage_note e dalle vulnerability delle sessioni del progetto,
// e che il traffico fuori dal crawler NON finisca nello stato.

function huntingDir(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "derive-")), "bugbounty", "programs", "acme")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe("derivazione dei fatti — i target vengono dall'evidenza", () => {
  test("senza sessioni non c'è nessun target", async () => {
    const dir = huntingDir()
    await Instance.provide({
      directory: dir,
      fn: async () => {
        const d = BountyState.derive(dir)
        expect(d.targets).toEqual([])
        expect(d.findings.total).toBe(0)
      },
    })
  })

  test("le coverage note di una sessione del progetto producono i target", async () => {
    const dir = huntingDir()
    await Instance.provide({
      directory: dir,
      fn: async () => {
        const session = await Session.create({ title: "hunt acme" })
        // l'agente dichiara di aver testato due asset
        CoverageNote.record({
          sessionID: session.id,
          asset: "https://app.example.com/admin",
          class: "idor",
          scope: "local",
          note: "testato",
        })
        CoverageNote.record({
          sessionID: session.id,
          asset: "https://api.example.com/v2/users",
          class: "injection",
          scope: "local",
          note: "testato",
        })

        const d = BountyState.derive(dir)
        // Due asset → un solo host per il primo, e api.example.com per il secondo
        expect(d.targets.map((t) => t.host).sort()).toEqual(["api.example.com", "app.example.com"])
      },
    })
  })

  test("più asset sullo STESSO host si aggregano in un target solo", async () => {
    const dir = huntingDir()
    await Instance.provide({
      directory: dir,
      fn: async () => {
        const session = await Session.create({ title: "hunt acme" })
        for (const pathName of ["/a", "/b", "/c"]) {
          CoverageNote.record({
            sessionID: session.id,
            asset: `https://app.example.com${pathName}`,
            class: "idor",
            scope: "local",
            note: "testato",
          })
        }
        const d = BountyState.derive(dir)
        expect(d.targets).toHaveLength(1)
        expect(d.targets[0]!.host).toBe("app.example.com")
      },
    })
  })

  test("i fatti di sessioni di ALTRI progetti NON entrano in questo stato", async () => {
    // La chiave è session.directory: una sessione aperta su un'altra directory
    // non deve inquinare questo progetto.
    const dir = huntingDir()
    const otherDir = huntingDir()

    const own = await Instance.provide({
      directory: dir,
      fn: async () => (await Session.create({ title: "acme" })).id,
    })
    const foreign = await Instance.provide({
      directory: otherDir,
      fn: async () => (await Session.create({ title: "altro" })).id,
    })

    CoverageNote.record({
      sessionID: own,
      asset: "https://app.example.com/x",
      class: "idor",
      scope: "local",
      note: "mio",
    })
    CoverageNote.record({
      sessionID: foreign,
      asset: "https://altro.example.com/y",
      class: "idor",
      scope: "local",
      note: "non mio",
    })

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const d = BountyState.derive(dir)
        expect(d.targets.map((t) => t.host)).toEqual(["app.example.com"])
      },
    })
  })

  test("refresh scrive il derivato nello stato e marca derivedAt", async () => {
    const dir = huntingDir()
    BountyState.write(BountyState.create({ directory: dir, program: "acme" }))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const session = await Session.create({ title: "hunt" })
        CoverageNote.record({
          sessionID: session.id,
          asset: "https://app.example.com/x",
          class: "idor",
          scope: "local",
          note: "testato",
        })

        const info = BountyState.refresh(dir, "acme")
        expect(info.derivedAt).not.toBeNull()
        expect(info.targets.map((t) => t.host)).toEqual(["app.example.com"])

        // e il derivato è persistito: rileggendolo lo ritroviamo
        const back = BountyState.read(dir)
        expect(back.targets.map((t) => t.host)).toEqual(["app.example.com"])
      },
    })
  })

  test("divergences riporta un target dichiarato senza evidenza", async () => {
    const dir = huntingDir()
    const declared = {
      ...BountyState.create({ directory: dir, program: "acme" }),
      targets: [{ host: "fantasma.example.com", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z", sessions: [] }],
    }
    const divergences = BountyState.divergences(declared, { targets: [], findings: { total: 0, new: 0, approved: 0, duplicate: 0, other: 0 } })
    expect(divergences.some((d) => d.includes("fantasma.example.com") && d.includes("senza evidenza"))).toBe(true)
  })

  test("lo stato si autoregola: uno stato che pecca per difetto si riallinea", async () => {
    // Il design dice: "se l'agente dimentica un aggiornamento push, lo stato
    // pecca per DIFETTO, non MENTE". Qui: lo stato dichiara zero target, ma
    // l'evidenza ne ha uno → refresh lo corregge.
    const dir = huntingDir()
    BountyState.write(BountyState.create({ directory: dir, program: "acme" }))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const session = await Session.create({ title: "hunt" })
        CoverageNote.record({
          sessionID: session.id,
          asset: "https://app.example.com/x",
          class: "idor",
          scope: "local",
          note: "testato",
        })
        expect(BountyState.read(dir).targets).toEqual([]) // pecca per difetto
        const info = BountyState.refresh(dir, "acme")
        expect(info.targets).toHaveLength(1) // riallineato
      },
    })
  })
})