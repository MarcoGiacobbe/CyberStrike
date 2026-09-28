import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir, symlink, readFile, rm, writeFile } from "fs/promises"
import { Instance } from "../../src/project/instance"
import { WriteTool } from "../../src/tool/write"
import { PermissionNext } from "../../src/permission/next"
import { ProjectPerimeter } from "../../src/permission/project"
import { tmpdir } from "../fixture/fixture"

/**
 * TOCTOU: il perimetro autorizzava, ma la scrittura finiva fuori.
 *
 * Il perimetro software autorizzava `programs/bcny/race.txt` (allow:1 deny:0)
 * e il file di un ALTRO programma (`programs/bcny-test/bersaglio.txt`,
 * contenuto SEGRETO) veniva lo stesso sovrascritto. Causa: il gate restituiva
 * un path come STRINGA, e quel nome veniva riaperto dalla syscall dopo
 * l'autorizzazione. Fra i due momenti un symlink spostava la destinazione.
 *
 * Correzione: aprire l'handle prima del gate e usare O_NOFOLLOW, cosi' il
 * kernel rifiuta il symlink (ELOOP) invece di seguirlo. userspace da solo non
 * puo' chiudere questa finestra.
 */
describe("TOCTOU fra gate e scrittura", () => {
  test("il symlink non sposta la destinazione della scrittura", async () => {
    const tmp = await tmpdir()
    const base = (tmp as any).path
    const project = path.join(base, "programs", "bcny")
    const other = path.join(base, "programs", "bcny-test")
    await mkdir(project, { recursive: true })
    await mkdir(other, { recursive: true })
    await using _t = tmp
    const diag = await ProjectPerimeter.diagnose(project)
    const perimeter = ProjectPerimeter.buildProjectRuleset(project, diag.worktree)
    const target = path.join(project, "race.txt")
    const victim = path.join(other, "bersaglio.txt")
    await writeFile(victim, "SEGRETO", "utf8")

    let allow = 0
    let deny = 0
    const ctx = {
      sessionID: "ses_test00000000000000000",
      messageID: "msg_test000000000000000",
      callID: "call_test0000000000000",
      agent: "test",
      abort: new AbortController().signal,
      extra: {},
      messages: [],
      metadata: async () => {},
      ask: async (req: any) => {
        await PermissionNext.ask({ ...req, ruleset: perimeter, always: [], sessionID: "ses_test00000000000000000" } as any)
        allow++
        // la corsa: il gate ha concesso e l'handle e' gia' aperto, ma il
        // contenuto non e' ancora stato scritto
        await rm(target, { force: true })
        await symlink(victim, target)
      },
    } as any

    await Instance.provide({
      directory: project,
      fn: async () => {
        await (await WriteTool.init()).execute({ filePath: target, content: "DENTRO" }, ctx)
      },
    })

    // CONTROLLO POSITIVO: il perimetro ha davvero concesso
    expect(allow).toBe(1)
    expect(deny).toBe(0)
    // e il contenuto fuori perimetro e' INTATTO
    expect(await readFile(victim, "utf8")).toBe("SEGRETO")
  })
})
