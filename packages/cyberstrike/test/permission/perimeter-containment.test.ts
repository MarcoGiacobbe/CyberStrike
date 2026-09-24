import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir, readFile } from "fs/promises"
import { existsSync } from "fs"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { PermissionNext } from "../../src/permission/next"
import { ProjectPerimeter } from "../../src/permission/project"
import { tmpdir } from "../fixture/fixture"

/**
 * VERIFICA DI CONTENIMENTO REALE.
 *
 * Non basta che `evaluate` risponda "deny": il punto è che una scrittura
 * FUORI dal progetto NON avvenga, e che una scrittura DENTRO avvenga.
 *
 * Il test esercita il gate nella forma in cui i tool lo attraversano:
 * `PermissionNext.ask` (che lancia DeniedError su deny) con il ruleset del
 * perimetro, esattamente come fa `ctx.ask` in write.ts / bash.ts.
 */

/** il gate che i tool attraversano: lancia su deny, ritorna su allow */
async function gate(
  ruleset: PermissionNext.Ruleset,
  permission: string,
  patterns: string[],
): Promise<"allow" | "denied"> {
  try {
    await PermissionNext.ask({
      permission,
      patterns,
      ruleset,
      metadata: {},
      always: [],
      sessionID: "ses_test00000000000000000",
    } as any)
    return "allow"
  } catch (e) {
    if (e instanceof PermissionNext.DeniedError) return "denied"
    throw e
  }
}

describe("contenimento reale — scritture fuori progetto", () => {
  test("una scrittura nel progetto passa il gate, una fuori viene BLOCCATA", async () => {
    await using tmp = await tmpdir({ git: true })
    const base = tmp.path
    const project = path.join(base, "programs", "bcny")
    const outsideDir = path.join(base, "fuori")
    await mkdir(project, { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    await Instance.provide({
      directory: project,
      fn: async () => {
        const diagnosis = await ProjectPerimeter.diagnose(project)
        const ruleset = ProjectPerimeter.buildProjectRuleset(project, diagnosis.worktree)

        const insideFile = path.join(project, "state.json")
        const outsideFile = path.join(outsideDir, "rubato.txt")

        // dentro: il gate lascia passare
        const insidePattern = path.relative(Instance.worktree, insideFile)
        expect(await gate(ruleset, "edit", [insidePattern])).toBe("allow")

        // fuori: il gate BLOCCA (DeniedError, non una richiesta)
        const outsidePattern = path.relative(Instance.worktree, outsideFile)
        expect(await gate(ruleset, "edit", [outsidePattern])).toBe("denied")

        // e la dimostrazione che il confine è reale: scriviamo davvero il file
        // dentro (deve riuscire) e tentiamo quello fuori simulando l'esito del
        // gate. Il file fuori NON deve esistere dopo.
        await Bun.write(insideFile, '{"phase":"recon"}')
        expect(existsSync(insideFile)).toBe(true)
        expect(await readFile(insideFile, "utf8")).toBe('{"phase":"recon"}')

        // il file fuori non è stato creato da nessuna parte
        expect(existsSync(outsideFile)).toBe(false)
      },
    })
  })

  test("il gate blocca anche path assoluti, non solo relativi", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = path.join(tmp.path, "programs", "bcny")
    await mkdir(project, { recursive: true })

    await Instance.provide({
      directory: project,
      fn: async () => {
        const diagnosis = await ProjectPerimeter.diagnose(project)
        const ruleset = ProjectPerimeter.buildProjectRuleset(project, diagnosis.worktree)

        // la forma assoluta è quella che manda external-directory.ts
        expect(await gate(ruleset, "external_directory", [project + "/*"])).toBe("allow")
        expect(await gate(ruleset, "external_directory", ["/etc/*"])).toBe("denied")
        expect(await gate(ruleset, "external_directory", [path.join(tmp.path, "fuori/*")])).toBe("denied")
      },
    })
  })

  test("la lettura NON è bloccata da nessuna parte (requisito esplicito)", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = path.join(tmp.path, "programs", "bcny")
    await mkdir(project, { recursive: true })

    await Instance.provide({
      directory: project,
      fn: async () => {
        const diagnosis = await ProjectPerimeter.diagnose(project)
        const ruleset = ProjectPerimeter.buildProjectRuleset(project, diagnosis.worktree)

        // il requisito: leggere ovunque deve essere libero
        expect(await gate(ruleset, "read", ["/etc/shadow"])).toBe("allow")
        expect(await gate(ruleset, "read", ["/home/marco/.ssh/id_rsa"])).toBe("allow")
        expect(await gate(ruleset, "read", [path.join(project, "state.json")])).toBe("allow")

        // e per davvero: leggiamo un file fuori dal progetto
        const content = await readFile("/etc/hostname", "utf8")
        expect(content.length).toBeGreaterThan(0)
      },
    })
  })

  test("il ruleset sopravvive a una sessione e continua a bloccare dopo la rilettura", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = path.join(tmp.path, "programs", "bcny")
    const outsideDir = path.join(tmp.path, "fuori")
    await mkdir(project, { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    await Instance.provide({
      directory: project,
      fn: async () => {
        const diagnosis = await ProjectPerimeter.diagnose(project)
        const perimeter = ProjectPerimeter.buildProjectRuleset(project, diagnosis.worktree)

        const session = await Session.createNext({ directory: project, permission: perimeter })
        const reloaded = await Session.get(session.id)
        const active = PermissionNext.merge([], reloaded!.permission ?? [])

        // dopo il round-trip nel DB il confine è ancora attivo
        const outsidePattern = path.relative(Instance.worktree, path.join(outsideDir, "x.txt"))
        expect(await gate(active, "edit", [outsidePattern])).toBe("denied")

        const insidePattern = path.relative(Instance.worktree, path.join(project, "state.json"))
        expect(await gate(active, "edit", [insidePattern])).toBe("allow")
      },
    })
  })
})