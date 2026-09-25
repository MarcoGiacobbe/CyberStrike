import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises"
import os from "os"
import { Instance } from "../../src/project/instance"
import { PermissionNext } from "../../src/permission/next"
import { ProjectPerimeter } from "../../src/permission/project"
import { Wildcard } from "../../src/util/wildcard"

/**
 * E2E del perimetro: esercita Instance + PermissionNext.evaluate + i pattern
 * che i tool mandano DAVVERO.
 *
 * Il punto non è il ruleset in astratto, ma che i pattern prodotti da
 * write.ts/edit.ts (relativi al worktree) e da external-directory.ts (assoluti)
 * vengano risolti correttamente dall'engine dei permessi.
 */

/** risolve un path come fa write.ts */
function editPattern(filepath: string) {
  return path.relative(Instance.worktree, filepath)
}

describe("perimetro E2E — progetto fuori da un repo (il caso bb hunt)", () => {
  test("write/edit: dentro allow, fuori deny, con Instance reale", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "bbperim-"))
    const project = path.join(base, "programs", "bcny")
    await mkdir(project, { recursive: true })
    await writeFile(path.join(project, "state.json"), "{}")

    try {
      await Instance.provide({
        directory: project,
        fn: async () => {
          const diagnosis = await ProjectPerimeter.diagnose(project)
          // senza .git il worktree dell'istanza è "/", esattamente lo scenario
          // "progetto fuori da un repo"
          expect(diagnosis.risk).toBe("no-repo")
          expect(ProjectPerimeter.isSafe(diagnosis)).toBe(true)

          const ruleset = ProjectPerimeter.buildProjectRuleset(project, diagnosis.worktree)

          // dentro il progetto -> allow
          const inside = PermissionNext.evaluate("edit", editPattern(path.join(project, "state.json")), ruleset)
          expect(inside.action).toBe("allow")

          const insideNested = PermissionNext.evaluate(
            "edit",
            editPattern(path.join(project, "scans", "report.md")),
            ruleset,
          )
          expect(insideNested.action).toBe("allow")

          // fuori dal progetto -> deny, senza possibilità di conferma
          const outside = PermissionNext.evaluate("edit", editPattern(path.join(base, "altro.txt")), ruleset)
          expect(outside.action).toBe("deny")

          const outsideHome = PermissionNext.evaluate("edit", editPattern(os.homedir() + "/.ssh/config"), ruleset)
          expect(outsideHome.action).toBe("deny")

          // sibling con prefisso simile -> deny (non deve fare prefix-matching)
          const sibling = PermissionNext.evaluate(
            "edit",
            editPattern(path.join(base, "programs", "bcny-altro", "x.json")),
            ruleset,
          )
          expect(sibling.action).toBe("deny")

          // la lettura resta libera
          const readAnywhere = PermissionNext.evaluate("read", "/etc/shadow", ruleset)
          expect(readAnywhere.action).toBe("allow")
        },
      })
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("external_directory segue lo stesso confine", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "bbperim-ext-"))
    const project = path.join(base, "bcny")
    await mkdir(project, { recursive: true })

    try {
      await Instance.provide({
        directory: project,
        fn: async () => {
          const diagnosis = await ProjectPerimeter.diagnose(project)
          const ruleset = ProjectPerimeter.buildProjectRuleset(project, diagnosis.worktree)

          // glob del progetto -> allow
          expect(PermissionNext.evaluate("external_directory", project + "/*", ruleset).action).toBe("allow")

          // glob di una dir fuori -> deny
          expect(PermissionNext.evaluate("external_directory", "/etc/*", ruleset).action).toBe("deny")
          expect(
            PermissionNext.evaluate("external_directory", os.homedir() + "/.ssh/*", ruleset).action,
          ).toBe("deny")
        },
      })
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe("perimetro E2E — il caso pericoloso: progetto radice di un repo", () => {
  test("diagnose lo segnala e isSafe lo rifiuta", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "bbperim-root-"))
    await mkdir(path.join(base, ".git"), { recursive: true })

    try {
      const diagnosis = await ProjectPerimeter.diagnose(base)
      expect(diagnosis.risk).toBe("project-is-repo-root")
      expect(ProjectPerimeter.isSafe(diagnosis)).toBe(false)
      expect(diagnosis.warning).toContain("NON è affidabile")
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("la ragione: nessun pattern relativo distingue interno ed esterno", () => {
    // Con projectDir === worktree, `path.relative` produce per un file interno
    // "state.json" e per uno esterno "../../../etc/passwd".
    const worktree = "/home/marco/repo-hunt"
    const projectDir = "/home/marco/repo-hunt"
    const insideRel = path.relative(worktree, projectDir + "/state.json")
    const outsideRel = path.relative(worktree, "/home/marco/.ssh/config")

    expect(insideRel).toBe("state.json")
    expect(path.relative(worktree, projectDir)).toBe("")

    // `buildProjectRuleset` deve RIFIUTARE questa configurazione invece di
    // emettere un ruleset. (Prima emetteva un pattern allow `"/*"` che il test
    // considerava inerte perche' provava solo path RELATIVI: `Wildcard.match`
    // lo traduce in `\/.*`, e `edit("/etc/passwd")` — path ASSOLUTO, che e' la
    // forma reale — risultava `allow`. Il rifiuto e' la sola risposta sicura.)
    expect(() => ProjectPerimeter.buildProjectRuleset(projectDir, worktree)).toThrow(/cannot be perimetrated/)

    // e un pattern che coprirebbe l'interno coprirebbe anche l'esterno:
    // non esiste forma relativa che separi i due casi. Da qui il rifiuto.
    expect(Wildcard.match(insideRel, "*")).toBe(true)
    expect(Wildcard.match(outsideRel, "*")).toBe(true)
    expect(Wildcard.match("/etc/passwd", "/*")).toBe(true)
  })
})