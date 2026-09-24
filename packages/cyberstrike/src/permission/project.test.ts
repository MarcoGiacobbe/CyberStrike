import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdtemp, rm, mkdir } from "fs/promises"
import os from "os"
import { ProjectPerimeter } from "./project"
import { PermissionNext } from "./next"
import { Wildcard } from "@/util/wildcard"

/** replica il calcolo che fa write.ts: path relativo alla radice del repo */
function writePattern(worktree: string | undefined, filepath: string) {
  return path.relative(worktree ?? "/", filepath)
}

/** replica la risoluzione dei permessi: l'ultima regola che matcha vince */
function resolve(ruleset: PermissionNext.Ruleset, permission: string, pattern: string) {
  const match = ruleset.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match?.action ?? "ask"
}

describe("ProjectPerimeter.buildProjectRuleset", () => {
  const project = "/home/marco/.cyberstrike/bugbounty/programs/bcny"

  describe("nessun repo git (worktree undefined -> '/')", () => {
    const ruleset = ProjectPerimeter.buildProjectRuleset(project, undefined)

    test("permette la scrittura dentro il progetto", () => {
      expect(
        resolve(ruleset, "edit", writePattern(undefined, project + "/state.json")),
      ).toBe("allow")
      expect(
        resolve(ruleset, "edit", writePattern(undefined, project + "/scans/a.txt")),
      ).toBe("allow")
    })

    test("nega la scrittura fuori dal progetto", () => {
      expect(resolve(ruleset, "edit", writePattern(undefined, "/home/marco/.ssh/config"))).toBe("deny")
      expect(resolve(ruleset, "edit", writePattern(undefined, "/etc/passwd"))).toBe("deny")
      expect(
        resolve(ruleset, "edit", writePattern(undefined, "/home/marco/.cyberstrike/credentials.json")),
      ).toBe("deny")
    })

    test("nega il sibling con prefisso simile al progetto", () => {
      // programs/bcny-altro NON deve essere scrivibile
      expect(
        resolve(ruleset, "edit", writePattern(undefined, "/home/marco/.cyberstrike/bugbounty/programs/bcny-altro/x")),
      ).toBe("deny")
    })

    test("la lettura resta libera", () => {
      expect(resolve(ruleset, "read", "/etc/shadow")).toBe("allow")
      expect(resolve(ruleset, "read", "/home/marco/qualsiasi")).toBe("allow")
    })
  })

  describe("progetto dentro un repo git", () => {
    const worktree = "/home/marco/mio-repo"
    const projectInRepo = worktree + "/bcny"
    const ruleset = ProjectPerimeter.buildProjectRuleset(projectInRepo, worktree)

    test("permette la scrittura dentro il progetto", () => {
      expect(resolve(ruleset, "edit", writePattern(worktree, projectInRepo + "/state.json"))).toBe("allow")
    })

    test("nega la scrittura altrove nel repo", () => {
      expect(resolve(ruleset, "edit", writePattern(worktree, worktree + "/altro.txt"))).toBe("deny")
      expect(resolve(ruleset, "edit", writePattern(worktree, worktree + "/src/index.ts"))).toBe("deny")
    })

    test("nega la scrittura fuori dal repo", () => {
      expect(resolve(ruleset, "edit", writePattern(worktree, "/etc/passwd"))).toBe("deny")
    })
  })

  describe("traversal", () => {
    const ruleset = ProjectPerimeter.buildProjectRuleset(project, undefined)

    test("un path con .. che esce dal progetto viene negato", () => {
      // il percorso reale normalizzato esce dal perimetro
      const escaping = path.resolve(project, "../../../.ssh/config")
      expect(resolve(ruleset, "edit", path.relative("/", escaping))).toBe("deny")
    })

    test("le scritture nel progetto con .. interno restano permesse", () => {
      const inside = path.resolve(project, "scans/../state.json")
      expect(resolve(ruleset, "edit", path.relative("/", inside))).toBe("allow")
    })
  })

  describe("bash", () => {
    const ruleset = ProjectPerimeter.buildProjectRuleset(project, undefined)

    test("un comando non riconosciuto chiede conferma, non passa in silenzio", () => {
      expect(resolve(ruleset, "bash", "qualcosa-di-nuovo --flag")).toBe("ask")
    })
  })
})

describe("ProjectPerimeter.diagnose", () => {
  test("directory senza .git -> risk no-repo, nessun avviso", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "perim-norepo-"))
    try {
      const d = await ProjectPerimeter.diagnose(dir)
      expect(d.risk).toBe("no-repo")
      expect(d.worktree).toBeUndefined()
      expect(d.warning).toBeUndefined()
      expect(ProjectPerimeter.isSafe(d)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("progetto radice di un repo -> risk project-is-repo-root, NON sicuro", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "perim-root-"))
    try {
      await mkdir(path.join(dir, ".git"), { recursive: true })
      const d = await ProjectPerimeter.diagnose(dir)
      expect(d.risk).toBe("project-is-repo-root")
      expect(d.warning).toBeDefined()
      expect(ProjectPerimeter.isSafe(d)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("progetto in sottocartella di un repo -> risk project-in-repo, sicuro con avviso", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "perim-inrepo-"))
    try {
      await mkdir(path.join(dir, ".git"), { recursive: true })
      await mkdir(path.join(dir, "bcny"), { recursive: true })
      const d = await ProjectPerimeter.diagnose(path.join(dir, "bcny"))
      expect(d.risk).toBe("project-in-repo")
      expect(d.warning).toBeDefined()
      expect(ProjectPerimeter.isSafe(d)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})