import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs"
import { Instance } from "../../src/project/instance"
import { LLM } from "../../src/session/llm"
import { BountyState } from "../../src/session/bounty-state"
import { Session } from "../../src/session"

// A5 — la forma meccanica del gate: `todowrite` non deve essere OFFERTO
// all'agente finché non ha caricato lo stato. Il blocco dentro il tool esiste
// anche, ma il contratto dichiarato e' "il tool MANCA": un tool che compare in
// lista e poi risponde "bloccato" viene chiamato, e dentro `batch` il rifiuto
// veniva pure contato come `successful`.

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bounty-llm-"))
process.env["CYBERSTRIKE_HOME"] = ROOT

function huntingDir(): string {
  const dir = path.join(ROOT, "bugbounty", "programs", "acme")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Un finto `tools` con i due tool che contano. */
const TOOLS = {
  todowrite: { description: "x", inputSchema: { jsonSchema: {} } } as never,
  bounty_status: { description: "y", inputSchema: { jsonSchema: {} } } as never,
  read: { description: "z", inputSchema: { jsonSchema: {} } } as never,
}

const AGENT = { permission: [] } as never
const USER = {} as never

describe("A5 — lista dei tool: il gate toglie todowrite, non lo fa 'rifiutare'", () => {
  test("su un progetto di hunting, PRIMA di bounty_status todowrite NON è nella lista", async () => {
    const dir = huntingDir()
    BountyState.write(BountyState.create({ directory: dir, program: "acme" }))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "llm gate" })).id
        const tools = await LLM.resolveTools({
          tools: { ...TOOLS },
          agent: AGENT,
          user: USER,
          sessionID: sid,
        })
        expect(Object.keys(tools)).not.toContain("todowrite")
        // e il tool che serve per sbloccare resta disponibile
        expect(Object.keys(tools)).toContain("bounty_status")
      },
    })
  })

  test("dopo bounty_status, todowrite TORNA nella lista", async () => {
    const dir = huntingDir()
    BountyState.write(BountyState.create({ directory: dir, program: "acme" }))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const sid = (await Session.create({ title: "llm gate" })).id
        BountyState.markLoaded(sid)
        const tools = await LLM.resolveTools({
          tools: { ...TOOLS },
          agent: AGENT,
          user: USER,
          sessionID: sid,
        })
        expect(Object.keys(tools)).toContain("todowrite")
      },
    })
  })

  test("fuori da un progetto di hunting todowrite c'è sempre", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "plain-"))

    await Instance.provide({
      directory: plain,
      fn: async () => {
        const sid = (await Session.create({ title: "llm gate" })).id
        const tools = await LLM.resolveTools({
          tools: { ...TOOLS },
          agent: AGENT,
          user: USER,
          sessionID: sid,
        })
        expect(Object.keys(tools)).toContain("todowrite")
      },
    })
  })
})