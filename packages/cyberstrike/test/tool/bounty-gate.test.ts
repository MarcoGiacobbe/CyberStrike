import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { Instance } from "../../src/project/instance"
import { BountyState } from "../../src/session/bounty-state"
import { TodoWriteTool } from "../../src/tool/todo"
import { BountyStatusTool } from "../../src/tool/bounty-status"
import { Todo } from "../../src/session/todo"
import { Session } from "../../src/session"

// Il gate del ticket stato-progetto, esercitato sul TOOL REALE: "l'agent NON ha
// todowrite finché non ha caricato lo stato". Non è una regola nel prompt — è
// un tool che manca. Questi test verificano che manchi davvero, e che si sblocchi
// quando e solo quando lo stato è stato caricato.

function huntingDir(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gate-")), "bugbounty", "programs", "acme")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const TODO = [{ content: "test the login flow", status: "pending", priority: "high" }]

/** ctx minimo che intercetta le richieste di permesso invece di bloccarsi. */
function ctxFor(sessionID: string) {
  const asks: string[] = []
  return {
    ctx: {
      sessionID,
      messageID: "msg_1",
      agent: "build",
      abort: new AbortController().signal,
      metadata: () => {},
      extra: {},
      messages: [],
      get: () => ({}),
      ask: async (a: { permission: string }) => {
        asks.push(a.permission)
      },
    } as never,
    asks,
  }
}

describe("gate todowrite — il tool manca finché lo stato non è caricato", () => {
  test("su un progetto di hunting, todowrite è BLOCCATO prima di bounty_status", async () => {
    const dir = huntingDir()
    BountyState.write(BountyState.create({ directory: dir, program: "acme" }))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "gate test" })).id
        const { ctx } = ctxFor(sid)
        const tool = await TodoWriteTool.init()
        const res = await tool.execute({ todos: TODO }, ctx)

        expect(res.title).toBe("blocked — load project state first")
        expect(res.output).toContain("bounty_status")
        expect(res.metadata.blockedBy).toBe("bounty-state-not-loaded")
        // e soprattutto: NIENTE è stato scritto nei todo
        expect(Todo.get(sid)).toEqual([])
      },
    })
  })

  test("dopo bounty_status, todowrite FUNZIONA e i todo vengono scritti", async () => {
    const dir = huntingDir()
    BountyState.write(BountyState.create({ directory: dir, program: "acme" }))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "gate test" })).id

        // 1) l'agente carica lo stato
        const status = await BountyStatusTool.init()
        const sres = await status.execute({ refresh: true }, ctxFor(sid).ctx)
        expect(sres.metadata.hunting).toBe(true)

        // 2) ora la pianificazione è permessa
        const write = await TodoWriteTool.init()
        const res = await write.execute({ todos: TODO }, ctxFor(sid).ctx)
        expect(res.title).toBe("1 todos")
        expect(Todo.get(sid)).toHaveLength(1)
      },
    })
  })

  test("il gate è PER-SESSIONE: sbloccare una sessione non sblocca le altre", async () => {
    const dir = huntingDir()
    BountyState.write(BountyState.create({ directory: dir, program: "acme" }))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const a = (await Session.create({ title: "a" })).id
        const b = (await Session.create({ title: "b" })).id

        const status = await BountyStatusTool.init()
        await status.execute({ refresh: true }, ctxFor(a).ctx)

        const write = await TodoWriteTool.init()
        // a è sbloccata
        expect((await write.execute({ todos: TODO }, ctxFor(a).ctx)).title).toBe("1 todos")
        // b no
        expect((await write.execute({ todos: TODO }, ctxFor(b).ctx)).title).toBe(
          "blocked — load project state first",
        )
      },
    })
  })

  test("su un progetto NON bounty il gate non si applica: todowrite funziona subito", async () => {
    // Fuori da un progetto bounty non c'è confine e non c'è stato da caricare:
    // bloccare qui sarebbe un ostacolo senza motivo.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plain-"))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "gate test" })).id
        const write = await TodoWriteTool.init()
        const res = await write.execute({ todos: TODO }, ctxFor(sid).ctx)
        expect(res.title).toBe("1 todos")
        expect(Todo.get(sid)).toHaveLength(1)
      },
    })
  })

  test("bounty_status su un progetto NON bounty lo dice, e NON inventa uno stato", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plain-"))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "gate test" })).id
        const status = await BountyStatusTool.init()
        const res = await status.execute({}, ctxFor(sid).ctx)

        expect(res.metadata.hunting).toBe(false)
        expect(res.output).toContain("not a bug-bounty project")
        // nessuno state.json creato: uno stato inventato sarebbe una
        // affermazione non dimostrabile
        expect(fs.existsSync(path.join(dir, "state.json"))).toBe(false)
      },
    })
  })
})

describe("bounty_status — contenuto e derivazione", () => {
  test("mostra fase, target e findings, e deriva dal DB", async () => {
    const dir = huntingDir()
    BountyState.write(BountyState.create({ directory: dir, program: "acme" }))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "gate test" })).id
        const status = await BountyStatusTool.init()
        const res = await status.execute({ refresh: true }, ctxFor(sid).ctx)

        expect(res.output).toContain("Program: acme")
        expect(res.output).toContain("Phase:   idle")
        expect(res.output).toContain("Targets touched: 0")
        expect(res.output).toContain("Findings: 0 total")
        expect(res.metadata.refreshed).toBe(true)
      },
    })
  })

  test("refresh:false mostra lo stato come memorizzato, senza ri-derivare", async () => {
    const dir = huntingDir()
    BountyState.write(BountyState.create({ directory: dir, program: "acme" }))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "gate test" })).id
        const status = await BountyStatusTool.init()
        const res = await status.execute({ refresh: false }, ctxFor(sid).ctx)
        expect(res.metadata.refreshed).toBe(false)
        expect(res.output).toContain("not re-derived")
      },
    })
  })

  test("refresh:false su uno stato ILLEGGIBILE fallisce invece di inventare", async () => {
    const dir = huntingDir()
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 42 }))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "gate test" })).id
        const status = await BountyStatusTool.init()
        await expect(status.execute({ refresh: false }, ctxFor(sid).ctx)).rejects.toThrow(/versione dello stato/)
      },
    })
  })
})