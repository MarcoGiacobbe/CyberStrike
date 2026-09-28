import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir, readFile, rm, symlink, writeFile, lstat } from "fs/promises"
import { Instance } from "../../src/project/instance"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { PermissionNext } from "../../src/permission/next"
import { ProjectPerimeter } from "../../src/permission/project"
import { tmpdir } from "../fixture/fixture"

/**
 * `apply_patch` con `move_path`: il perimetro concedeva, la scrittura finiva
 * fuori.
 *
 * Due difetti, entrambi reali (misurati il 2026-09-28):
 *
 * 1. `assertExternalDirectory(ctx, movePath)` veniva chiamata ma il RISULTATO
 *    era scartato: la validazione girava e poi nessuno ne faceva niente.
 * 2. la scrittura usava `fs.writeFile`, che riapre il path per nome. Fra il
 *    gate e quella riga un symlink spostava la destinazione.
 *
 * Con il perimetro in regola (allow:1 deny:0) il contenuto di un ALTRO
 * programma (`programs/bcny-test/bersaglio.txt`, contenuto SEGRETO) veniva
 * sovrascritto dal contenuto del file spostato.
 *
 * Correzione: il path canonico viene USATO, e la scrittura passa da
 * `openChecked`/`writeChecked` con `O_NOFOLLOW` (stessa difesa di write.ts).
 */
describe("apply_patch move_path", () => {
  test("il symlink non sposta la destinazione del move", async () => {
    const tmp = await tmpdir()
    const base = (tmp as any).path
    const project = path.join(base, "programs", "bcny")
    const other = path.join(base, "programs", "bcny-test")
    await mkdir(project, { recursive: true })
    await mkdir(other, { recursive: true })
    await using _t = tmp
    const diag = await ProjectPerimeter.diagnose(project)
    const perimeter = ProjectPerimeter.buildProjectRuleset(project, diag.worktree)
    await writeFile(path.join(project, "sorgente.txt"), "contenuto interno\n", "utf8")
    const victim = path.join(other, "bersaglio.txt")
    await writeFile(victim, "SEGRETO", "utf8")
    const movePath = path.join(project, "spostato.txt")

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
        try {
          await PermissionNext.ask({
            ...req,
            ruleset: perimeter,
            always: [],
            sessionID: "ses_test00000000000000000",
          } as any)
          allow++
          // la corsa: dopo l'autorizzazione il nome della destinazione
          // diventa un link verso un altro programma
          await rm(movePath, { force: true })
          await symlink(victim, movePath)
        } catch (e) {
          if (e instanceof PermissionNext.DeniedError) deny++
          throw e
        }
      },
    } as any

    let applicata = false
    let bloccata = ""
    await Instance.provide({
      directory: project,
      fn: async () => {
        try {
          await (await ApplyPatchTool.init()).execute(
            {
              patchText:
                "*** Begin Patch\n" +
                "*** Update File: sorgente.txt\n" +
                "*** Move to: spostato.txt\n" +
                "@@\n" +
                "-contenuto interno\n" +
                "+contenuto nuovo\n" +
                "*** End Patch",
            },
            ctx,
          )
          applicata = true
        } catch (e) {
          bloccata = String(e)
        }
      },
    })

    // CONTROLLO POSITIVO: il perimetro ha davvero concesso.
    expect(allow).toBe(1)
    expect(deny).toBe(0)
    // il contenuto fuori perimetro e' INTATTO: questo e' la proprieta' che conta
    expect(await readFile(victim, "utf8")).toBe("SEGRETO")
    // `spostato.txt` e' rimasto il symlink creato dall'attaccante: la scrittura
    // non e' passata, quindi il nome non e' stato sovrascritto. Non lo leggo
    // per contenuto perche' seguirebbe il link fino alla vittima.
    expect((await lstat(movePath)).isSymbolicLink()).toBe(true)
    // il sorgente dentro bcny non e' stato cancellato dal unlink
    expect(await readFile(path.join(project, "sorgente.txt"), "utf8").catch(() => "")).toBe("contenuto interno\n")
    // controllo che il test abbia davvero attraversato uno dei due rami
    expect(applicata || bloccata.length > 0).toBe(true)
  })
})
