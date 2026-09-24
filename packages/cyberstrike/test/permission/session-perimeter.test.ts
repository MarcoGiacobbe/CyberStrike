import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "fs/promises"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { PermissionNext } from "../../src/permission/next"
import { ProjectPerimeter } from "../../src/permission/project"
import { tmpdir } from "../fixture/fixture"

/**
 * E2E del perimetro attraverso la SESSIONE REALE.
 *
 * I test unit verificano `buildProjectRuleset` in isolamento; il test
 * tool-perimeter verifica `Instance` + `evaluate`. Questo test chiude il ciclo
 * che mancava: il ruleset viene passato a `session.createNext({ permission })`,
 * PERSISTITO nel DB, e riletto — cioè esattamente ciò che fara' `bb hunt`.
 *
 * Il punto critico: verificare che la persistenza non perda o alteri il
 * ruleset, e che il merge con i permessi dell'agente (dove la sessione vince,
 * perche' evaluate usa findLast) produca davvero il confine voluto.
 */

/** replica la fusione fatta da src/session/prompt.ts:1091 */
function activeRuleset(agentRuleset: PermissionNext.Ruleset, session: { permission?: PermissionNext.Ruleset }) {
  return PermissionNext.merge(agentRuleset, session.permission ?? [])
}

describe("E2E sessione — il ruleset del perimetro sopravvive a createNext", () => {
  test("il ruleset viene persistito e riletto identico", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = path.join(tmp.path, "programs", "bcny")
    await mkdir(project, { recursive: true })

    await Instance.provide({
      directory: project,
      fn: async () => {
        const diagnosis = await ProjectPerimeter.diagnose(project)
        const ruleset = ProjectPerimeter.buildProjectRuleset(project, diagnosis.worktree)

        const session = await Session.createNext({
          directory: project,
          title: "bb hunt bcny",
          permission: ruleset,
        })

        // il ruleset e' stato passato alla sessione
        expect(session.permission).toBeDefined()
        expect(session.permission!.length).toBe(ruleset.length)

        // riletto dal DB, identico
        const reloaded = await Session.get(session.id)
        expect(reloaded).toBeDefined()
        expect(reloaded!.permission).toEqual(ruleset)
      },
    })
  })

  test("il confine regge anche quando l'agente porta i PROPRI permessi", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = path.join(tmp.path, "programs", "bcny")
    await mkdir(project, { recursive: true })

    await Instance.provide({
      directory: project,
      fn: async () => {
        const diagnosis = await ProjectPerimeter.diagnose(project)
        const perimeter = ProjectPerimeter.buildProjectRuleset(project, diagnosis.worktree)

        // un agente permissivo: se il merge sbagliasse l'ordine, vincerebbe lui
        const permissiveAgent: PermissionNext.Ruleset = [
          { permission: "edit", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "read", pattern: "*", action: "allow" },
        ]

        const session = await Session.createNext({
          directory: project,
          title: "bb hunt bcny",
          permission: perimeter,
        })
        const reloaded = await Session.get(session.id)
        const active = activeRuleset(permissiveAgent, reloaded!)

        // i pattern vanno calcolati come li calcola write.ts: relativo a
        // Instance.worktree. È il contratto implicito del modulo: chi costruisce
        // il ruleset deve usare lo STESSO worktree che usa l'istanza.
        const inside = path.relative(Instance.worktree, path.join(project, "state.json"))
        const outside = path.relative(Instance.worktree, "/home/marco/.ssh/config")

        // il perimetro deve vincere sui permessi permissivi dell'agente
        expect(PermissionNext.evaluate("edit", inside, active).action).toBe("allow")
        expect(PermissionNext.evaluate("edit", outside, active).action).toBe("deny")

        // anche un agente con bash allow non scavalca il gate del perimetro
        expect(PermissionNext.evaluate("bash", "rm -rf /tmp/x", active).action).toBe("ask")
      },
    })
  })

  test("CONTRATTO: il worktree passato deve essere quello dell'istanza", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = path.join(tmp.path, "programs", "bcny")
    await mkdir(project, { recursive: true })

    await Instance.provide({
      directory: project,
      fn: async () => {
        const diagnosis = await ProjectPerimeter.diagnose(project)
        // il worktree rilevato dal modulo coincide con quello dell'istanza:
        // se non coincidesse, i pattern relativi non matcherebbero e il
        // perimetro negherebbe anche l'interno. Questo test fissa il contratto.
        expect(diagnosis.worktree).toBe(Instance.worktree)

        // con il worktree SBAGLIATO il perimetro si rompe (dimostrazione)
        const wrong = ProjectPerimeter.buildProjectRuleset(project, "/")
        const inside = path.relative(Instance.worktree, path.join(project, "state.json"))
        expect(PermissionNext.evaluate("edit", inside, wrong).action).toBe("deny")

        // con quello corretto funziona
        const right = ProjectPerimeter.buildProjectRuleset(project, diagnosis.worktree)
        expect(PermissionNext.evaluate("edit", inside, right).action).toBe("allow")
      },
    })
  })

  test("senza perimetro esplicito una sessione NON e' confinata (baseline)", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = path.join(tmp.path, "programs", "bcny")
    await mkdir(project, { recursive: true })

    await Instance.provide({
      directory: project,
      fn: async () => {
        const session = await Session.createNext({ directory: project, title: "no perimeter" })
        // nessun ruleset -> il perimetro NON e' attivo: e' il motivo per cui
        // bb hunt deve passarlo esplicitamente, non darlo per scontato
        expect(session.permission).toBeUndefined()

        const emptyAgent: PermissionNext.Ruleset = []
        const active = activeRuleset(emptyAgent, session)
        // senza regole, il default dell'engine e' "ask" (non deny, non allow)
        expect(PermissionNext.evaluate("edit", "qualsiasi", active).action).toBe("ask")
      },
    })
  })
})

describe("E2E sessione — il caso rifiutato da diagnose non deve arrivare alla sessione", () => {
  test("un progetto che e' radice di repo viene fermato prima di createNext", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const diagnosis = await ProjectPerimeter.diagnose(tmp.path)
        expect(diagnosis.risk).toBe("project-is-repo-root")
        expect(ProjectPerimeter.isSafe(diagnosis)).toBe(false)

        // il contratto: chi consuma il modulo DEVE controllare isSafe prima di
        // costruire la sessione. Questo test fissa quel contratto.
        expect(diagnosis.warning).toBeDefined()
      },
    })
  })
})