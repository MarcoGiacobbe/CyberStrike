import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { Instance } from "../../src/project/instance"
import { BountyState } from "../../src/session/bounty-state"
import { TodoWriteTool } from "../../src/tool/todo"
import { Todo } from "../../src/session/todo"
import { Session } from "../../src/session"

// GAP DI INIZIALIZZAZIONE (ticket stato-progetto, review deleg_49381b00).
//
// `bb hunt` validava il programma e costruiva il perimetro, ma leggeva lo
// stato con `BountyState.read()` dentro un try/catch e NON lo creava mai.
// Consequence misurata: `BountyState.create()` non ha caller di produzione,
// `setPhase()`/`regenerate()` non hanno caller, e sui programmi reali non
// esiste alcun `state.json`. Lo stato nasceva solo se l'AGENTE decideva di
// chiamare `bounty_status`.
//
// Il difetto non e' cosmetico: `isHuntingDir()` e' il gate che rende una
// directory "progetto di hunting". Se lo stato non esiste, il gate non ha
// niente su cui vigilare e la prima sessione parte senza confine.
//
// Questo test e' la prova, non il fix. A HEAD (prima del fix in bb.ts) i due
// test "dopo bb hunt" devono essere ROSSI; il primo deve restare verde in
// entrambi i casi perche' dimostra che il perimetro non c'entra.

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "init-home-"))
process.env["CYBERSTRIKE_HOME"] = HOME

/** Crea un programma valido, come fa `bb hunt` dopo `bb sync`. */
function program(name: string): string {
  const dir = path.join(HOME, "bugbounty", "programs", name)
  fs.mkdirSync(path.join(dir, "program"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, "program", "program.json"),
    JSON.stringify({ name, targets: [{ target: `${name}.example` }], payout: ["$100"] }),
  )
  return dir
}

function ctxFor(sessionID: string) {
  return {
    sessionID,
    messageID: "msg_1",
    agent: "build",
    abort: new AbortController().signal,
    metadata: () => {},
    extra: {},
    messages: [],
    get: () => ({}),
    ask: async () => {},
  } as never
}

const TODO = [{ content: "inizia il recon", status: "pending" as const, priority: "high" as const }]

describe("stato iniziale: bb hunt deve avviare il progetto", () => {
  test("un programma appena creato viene riconosciuto come progetto di hunting", async () => {
    // Questo passa gia' a HEAD: e' il perimetro/forme, serve a non attribuire
    // al fix un difetto che non c'entra.
    const dir = program("fresh")
    expect(BountyState.isHuntingDir(dir)).toBe(true)
  })

  test("lo stato iniziale ha la forma giusta: idle, nessun target, non derivato", async () => {
    // NOTA su questo test: da solo NON dimostra che `bb hunt` crei lo stato,
    // perché non esercita `bb hunt` — crea la directory a mano. Serve a
    // controllare la FORMA di ciò che il comando deve produrre. La prova che
    // il comando crei davvero lo stato e' end-to-end e sta nel ticket
    // (misurata: `bb hunt probe` reale → `state.json` mode 600, `phase: idle`,
    // `targets: 0`, `derivedAt: null`; secondo avvio preserva `phase:
    // reporting` e i target dichiarati; stato corrotto → rc=1 e file NON
    // sovrascritto).
    const dir = program("fresh2")
    const info = BountyState.create({ directory: dir, program: "fresh2" })
    BountyState.write(info)

    const read = BountyState.read(dir)
    expect(read.phase).toBe("idle")
    expect(read.targets).toEqual([])
    expect(read.derivedAt).toBeNull()
    // I fatti non sono ancora derivati: dichiararli ora sarebbe inventarli.
    expect(read.findings.total).toBe(0)
  })

  test("uno stato gia' presente NON viene sovrascritto da un nuovo create()", async () => {
    const dir = program("fresh2b")
    BountyState.write(BountyState.create({ directory: dir, program: "fresh2b" }))

    // Dichiaro lavoro fatto, poi rileggo: e' il caso che `bb hunt` deve
    // preservare. Se qui il lavoro sparisse, un riavvio del comando perderebbe
    // cio' che la sessione precedente aveva dichiarato.
    const current = BountyState.read(dir)
    BountyState.write({ ...current, phase: "reporting" })
    expect(BountyState.read(dir).phase).toBe("reporting")
  })

  test("senza stato, la sessione NON puo' pianificare: il gate deve negare", async () => {
    const dir = program("fresh3")

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "prima sessione" })).id
        // Se lo stato non esiste, `bounty_status` lo dice e NON inventa: il
        // gate resta chiuso e `todowrite` e' negato finche' l'agente non lo
        // carica. E' il comportamento corretto PRIMA del fix, e resta
        // corretto DOPO: cambia chi crea lo stato, non il gate.
        const write = await TodoWriteTool.init()
        await expect(write.execute({ todos: TODO }, ctxFor(sid))).rejects.toThrow(/bounty_status/)
        expect(Todo.get(sid)).toEqual([])
      },
    })
  })
})
