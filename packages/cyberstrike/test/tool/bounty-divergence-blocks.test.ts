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

// RIPRODUZIONE INDIPENDENTE del difetto P1 trovato dalla review avversariale
// deleg_49381b00 (2026-09-28). A HEAD questo test deve tornare ROSSO.
//
// Il ticket `stato-progetto` decide: se lo stato dichiarato contraddice i fatti
// derivati dall'evidenza, "la sessione si blocca finche' non si risincronizza".
// Misurato a HEAD: la sessione NON si blocca. Con refresh:false,
// `readChecked()` chiama `markLoaded()` (bounty-status.ts:131) prima che
// `divergences()` venga valutato (bounty-status.ts:62), quindi todowrite si
// sblocca su uno stato che il tool stesso dichiara inaffidabile.
//
// Questo file e' la prova, non il fix: se qualcuno lo modifica insieme al fix,
// la difesa si autosmonta. Il fix vive in bounty-status.ts.

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "p1-div-home-"))
process.env["CYBERSTRIKE_HOME"] = HOME

function lyingDir(): string {
  const dir = path.join(HOME, "bugbounty", "programs", "liar")
  fs.mkdirSync(dir, { recursive: true })
  // Tre target dichiarati, phase avanzata, e ZERO evidenza nel DB: il
  // programma non e' mai stato toccato. E' il caso "lo stato mente".
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

const TODO = [{ content: "pianifica su dati che mentono", status: "pending" as const, priority: "high" as const }]

describe("P1 — la divergenza deve BLOCCARE la sessione, non solo avvisare", () => {
  test("refresh:false su stato che contraddice l'evidenza NON deve sbloccare todowrite", async () => {
    const dir = lyingDir()

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "p1 divergence" })).id

        // 1) bounty_status deveVEDERE le divergenze: lo strumento sa che i
        //    dati dichiarati non tornano con l'evidenza registrata.
        const status = await BountyStatusTool.init()
        const sres = await status.execute({ refresh: false }, ctxFor(sid))
        expect(sres.metadata.hunting).toBe(true)
        expect(sres.metadata.divergences).toBeGreaterThan(0)
        expect(sres.output).toContain("disagrees with recorded evidence")

        // 2) Il punto del ticket: la sessione deve restare BLOCCATA. A HEAD
        //    non lo e' — readChecked() ha gia' chiamato markLoaded() alla riga
        //    131, prima che divergences() fosse valutato alla riga 62.
        expect(BountyState.loaded(sid)).toBe(false)

        // 3) E quindi todowrite deve essere negato, e nulla scritto. Se il gate
        //    cede, il TODO entra e l'agente pianifica su cifre che il passo 1
        //    ha appena dichiarato inaffidabili.
        const write = await TodoWriteTool.init()
        await expect(write.execute({ todos: TODO }, ctxFor(sid))).rejects.toThrow(/bounty_status/)
        expect(Todo.get(sid)).toEqual([])
      },
    })
  })
})
