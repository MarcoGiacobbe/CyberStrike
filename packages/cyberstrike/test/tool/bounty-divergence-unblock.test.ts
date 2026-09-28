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

// Il blocco per divergenza è un blocco che si deve poter RIAPRIRE. Un gate
// che non si sblocca mai è indistinguibile da un gate che non misura niente:
// l'agente resterebbe intrappolato in un vicolo cieco.
//
// Percorso: stato che mente → bloccato → refresh:true ri-deriva dagli fatti →
// sbloccato → todowrite torna a funzionare.

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "p1-unblock-home-"))
process.env["CYBERSTRIKE_HOME"] = HOME

function lyingDir(): string {
  const dir = path.join(HOME, "bugbounty", "programs", "liar")
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString()
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      version: 1,
      directory: dir,
      program: "liar",
      phase: "recon",
      phaseUpdatedAt: now,
      derivedAt: now,
      targets: ["a.example", "b.example", "c.example"].map((host) => ({
        host,
        firstSeen: now,
        lastSeen: now,
        sessions: ["ses_fabricata"],
      })),
      findings: { total: 0, new: 0, approved: 0, duplicate: 0, other: 0 },
      updatedAt: now,
    }),
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

const TODO = [{ content: "pianifica", status: "pending" as const, priority: "high" as const }]

describe("il blocco per divergenza si deve poter RIAPRIRE", () => {
  test("refresh:true ri-deriva, risolve la divergenza e sblocca todowrite", async () => {
    const dir = lyingDir()

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "unblock" })).id

        // 1) lettura non ri-derivata sullo stato che mente → bloccato
        const status = await BountyStatusTool.init()
        const bad = await status.execute({ refresh: false }, ctxFor(sid))
        expect(bad.metadata.divergences).toBeGreaterThan(0)
        expect(BountyState.isBlocked(sid)).toBe(true)

        const blockedWrite = await TodoWriteTool.init()
        await expect(blockedWrite.execute({ todos: TODO }, ctxFor(sid))).rejects.toThrow(/evidenza registrata/)
        expect(Todo.get(sid)).toEqual([])

        // 2) refresh:true ri-deriva dallo stato DERIVATO (zero target, zero
        //    evidenza) e riscrive: la divergenza è risolta per costruzione.
        const good = await status.execute({ refresh: true }, ctxFor(sid))
        expect(good.metadata.divergences).toBe(0)
        expect(BountyState.isBlocked(sid)).toBe(false)
        expect(BountyState.loaded(sid)).toBe(true)

        // 3) e a questo punto pianificare è legittimo
        const write = await TodoWriteTool.init()
        const res = await write.execute({ todos: TODO }, ctxFor(sid))
        expect(res.title).toBe("1 todos")
        expect(Todo.get(sid)).toHaveLength(1)
      },
    })
  })

  test("il blocco è per-sessione: un'altra sessione non eredita il blocco", async () => {
    const dir = lyingDir()

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const a = (await Session.create({ title: "bloccata" })).id
        const b = (await Session.create({ title: "pulita" })).id

        const status = await BountyStatusTool.init()
        await status.execute({ refresh: false }, ctxFor(a))
        expect(BountyState.isBlocked(a)).toBe(true)
        // La sessione B non ha letto niente: non è "sbloccata", è semplicemente
        // una sessione che non ha ancora guardato. Se si dichiarasse sbloccata
        // sarebbe un buco: deve invece negare finché non carica.
        expect(BountyState.isBlocked(b)).toBe(false)
        const write = await TodoWriteTool.init()
        await expect(write.execute({ todos: TODO }, ctxFor(b))).rejects.toThrow(/bounty_status/)
      },
    })
  })
})
