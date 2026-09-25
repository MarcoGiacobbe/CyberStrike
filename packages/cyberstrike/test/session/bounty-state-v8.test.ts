import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"

// Regressione della verifica V8 (wayfinder/bb-autonomous-flow/tickets/
// verifica-fix-v8.md): i buchi P5-P12. La causa comune era confrontare per
// uguaglianza LETTERALE dove serve una PROPRIETÀ (path canonici, segmenti,
// "copre tutto"), e sanificare campo per campo invece che all'emissione.

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "v8-home-"))
process.env["CYBERSTRIKE_HOME"] = HOME

const { BountyState } = await import("../../src/session/bounty-state")

function program(name: string): string {
  const dir = path.join(HOME, "bugbounty", "programs", name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function validState(dir: string, over: Record<string, unknown> = {}) {
  return {
    version: BountyState.VERSION,
    directory: dir,
    program: path.basename(dir),
    phase: "testing",
    phaseUpdatedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    derivedAt: null,
    targets: [],
    findings: { total: 0, new: 0, approved: 0, duplicate: 0, other: 0 },
    ...over,
  }
}

describe("P6/P7 — symlink e base non canonica", () => {
  test("P6: un symlink dentro programs/ che punta FUORI non è un progetto", () => {
    // Prima veniva riconosciuto, e bounty_status ci scriveva dentro state.json:
    // la scrittura usciva dalla base e finiva nella directory vittima.
    const fuori = fs.mkdtempSync(path.join(os.tmpdir(), "v8-vittima-"))
    fs.writeFileSync(path.join(fuori, "dato-dell-utente.txt"), "roba mia")
    const link = path.join(HOME, "bugbounty", "programs", "innocuo")
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(fuori, link)

    expect(BountyState.isHuntingDir(link)).toBe(false)
    // La prova che conta: nessuno stato scritto nella directory esterna.
    expect(fs.existsSync(path.join(fuori, "state.json"))).toBe(false)
  })

  test("P7: una base scritta con `..` è la stessa base (stesso progetto riconosciuto)", () => {
    const dir = program("p7")
    const storta = path.join(HOME, "bugbounty", "programs", "..", "programs", "p7")
    expect(BountyState.isHuntingDir(storta)).toBe(true)
  })

  test("P7: CYBERSTRIKE_HOME non canonico non spegne il gate", () => {
    const dir = program("p7b")
    // `path.resolve` dentro root() assorbe lo spelling: il progetto resta un
    // progetto anche se lo si nomina con uno slash doppio.
    const storta = path.join(HOME, "bugbounty", "//programs//p7b")
    expect(BountyState.isHuntingDir(storta)).toBe(true)
    expect(BountyState.isHuntingDir(path.join(dir, "."))).toBe(true)
  })

  test("un nome di programma che inizia con `..` NON spegne il riconoscimento", () => {
    // Il check precedente (`rel.startsWith("..")` su stringa) respingeva un
    // progetto legittimo solo perché il nome cominciava con due punti.
    const dir = program("..acme")
    expect(BountyState.isHuntingDir(dir)).toBe(true)
  })
})

describe("P5 — la guardia del perimetro copre la classe 'salita', non solo rel === ''", () => {
  test("lancia quando la directory del progetto è il worktree", async () => {
    const { ProjectPerimeter } = await import("../../src/permission/project")
    const dir = program("p5a")
    expect(() => ProjectPerimeter.buildProjectRuleset(dir, dir)).toThrow(/cannot be perimetrated/)
  })

  test("lancia quando la directory è il GENITORE del worktree (rel = '..')", async () => {
    const { ProjectPerimeter } = await import("../../src/permission/project")
    const wt = program("p5b")
    const genitore = path.dirname(wt)
    expect(() => ProjectPerimeter.buildProjectRuleset(genitore, wt)).toThrow(/cannot be perimetrated/)
  })

  test("lancia con la radice del filesystem (rel di sola salita)", async () => {
    const { ProjectPerimeter } = await import("../../src/permission/project")
    const wt = program("p5c")
    expect(() => ProjectPerimeter.buildProjectRuleset("/", wt)).toThrow(/cannot be perimetrated/)
  })

  test("NON lancia quando la directory è un vero discendente", async () => {
    const { ProjectPerimeter } = await import("../../src/permission/project")
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "v8-repo-"))
    const dentro = path.join(wt, "sotto", "progetto")
    fs.mkdirSync(dentro, { recursive: true })
    expect(() => ProjectPerimeter.buildProjectRuleset(dentro, wt)).not.toThrow()
  })
})

describe("P9 — lo stato appartiene al progetto che DICHIARA", () => {
  test("read() rifiuta uno state.json che dichiara un'ALTRA directory", () => {
    // Riproduzione senza forgiatura: `mv acme acme-2026`. Prima la directory
    // nuova presentava il programma vecchio e riscriveva il suo state.json.
    const a = program("p9a")
    const b = program("p9b")
    fs.writeFileSync(path.join(a, "state.json"), JSON.stringify(validState(b)))

    expect(() => BountyState.read(a)).toThrow(/dichiara la directory/)
    expect(BountyState.exists(a)).toBe(false)
  })

  test("read() accetta la stessa directory scritta in modo diverso (slash finale, symlink)", () => {
    const dir = program("p9c")
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(validState(dir)))
    expect(BountyState.read(dir + "/").program).toBe("p9c")

    const link = path.join(HOME, "bugbounty", "programs", "p9c-link")
    fs.symlinkSync(dir, link)
    expect(BountyState.read(link).program).toBe("p9c")
  })
})

describe("P8 — un symlink dangling non riapre B1", () => {
  test("lo state.json che è un link rotto è 'presente ma non leggibile', non 'assente'", () => {
    const dir = program("p8")
    const reale = path.join(dir, "vero.json")
    fs.writeFileSync(reale, JSON.stringify(validState(dir)))
    fs.symlinkSync(reale, path.join(dir, "state.json"))
    fs.unlinkSync(reale) // il link resta, il bersaglio no

    // La prova che `existsSync` sbagliava: la voce nell'albero c'è ancora.
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(false)
    expect(() => {
      fs.lstatSync(path.join(dir, "state.json"))
    }).not.toThrow()

    expect(() => BountyState.read(dir)).toThrow(BountyState.Unreadable)
  })
})

describe("P11 — il gate non si arma in anticipo e non accetta sottodirectory", () => {
  test("una sottodirectory di un progetto NON è essa stessa un progetto", () => {
    const dir = program("p11")
    const sotto = path.join(dir, "scans", "reports")
    fs.mkdirSync(sotto, { recursive: true })
    expect(BountyState.isHuntingDir(sotto)).toBe(false)
  })

  test("uno state.json di SCHEMA ESTRANEO fuori dal layout non è un progetto bounty", () => {
    // Una repo con `state.json` (es. Terraform) armava il gate, e poi
    // bounty_status non poteva sbloccarlo: sessione bloccata per sempre.
    const repo = fs.mkdtempSync(path.join(HOME, "repo-"))
    fs.writeFileSync(path.join(repo, "state.json"), JSON.stringify({ risorse: 3, nome: "infra" }))
    expect(BountyState.isHuntingDir(repo)).toBe(false)
  })

  test("uno stato VALIDO fuori dal layout resta un progetto (progetto spostato)", () => {
    const fuori = fs.mkdtempSync(path.join(HOME, "spostato-"))
    fs.writeFileSync(path.join(fuori, "state.json"), JSON.stringify(validState(fuori)))
    expect(BountyState.isHuntingDir(fuori)).toBe(true)
  })
})

describe("P12 — i fatti derivati non si azzerano per uno spelling diverso", () => {
  test("derive() usa il path canonico: lo slash finale non azzera i fatti", async () => {
    const { Instance } = await import("../../src/project/instance")
    const { Session } = await import("../../src/session")
    const dir = program("p12")

    // Una sessione con evidenza, registrata con il path canonico.
    let sid = ""
    await Instance.provide({
      directory: dir,
      fn: async () => {
        sid = (await Session.create({ title: "p12" })).id
      },
    })

    const dritta = BountyState.derive(dir)
    const storta = BountyState.derive(dir + "/")
    expect(storta.targets.length).toBe(dritta.targets.length)
    expect(storta.findings.total).toBe(dritta.findings.total)
    expect(sid.length).toBeGreaterThan(0)
  })

  test("divergences() rileva la SCOMPOSIZIONE falsa, non solo il totale", () => {
    const dir = program("p12b")
    const declared = validState(dir, {
      // totale coerente, scomposizione falsa: prima passava in silenzio.
      findings: { total: 5, new: 0, approved: 5, duplicate: 0, other: 0 },
    }) as never

    const derived = {
      targets: [],
      findings: { total: 5, new: 5, approved: 0, duplicate: 0, other: 0 },
    }
    const out = BountyState.divergences(declared, derived)
    expect(out.some((d) => /approved/.test(d))).toBe(true)
    expect(out.some((d) => /new/.test(d))).toBe(true)
  })

  test("divergences() rileva la prova falsa di un target (sessions, firstSeen)", () => {
    const dir = program("p12c")
    const declared = validState(dir, {
      targets: [
        {
          host: "api.example.com",
          firstSeen: "2019-01-01T00:00:00.000Z",
          lastSeen: "2026-01-01T00:00:00.000Z",
          sessions: ["a", "b", "c", "d"],
        },
      ],
    }) as never

    const derived = {
      targets: [
        {
          host: "api.example.com",
          firstSeen: "2026-06-01T00:00:00.000Z",
          lastSeen: "2026-06-01T00:00:00.000Z",
          sessions: ["a"],
        },
      ],
      findings: { total: 0, new: 0, approved: 0, duplicate: 0, other: 0 },
    }

    const out = BountyState.divergences(declared, derived)
    expect(out.some((d) => /4 sessioni/.test(d) || /sessioni/.test(d))).toBe(true)
    expect(out.some((d) => /firstSeen/.test(d))).toBe(true)
  })
})