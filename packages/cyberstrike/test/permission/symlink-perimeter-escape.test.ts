import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir, symlink, readFile } from "fs/promises"
import { existsSync } from "fs"
import { Instance } from "../../src/project/instance"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { PermissionNext } from "../../src/permission/next"
import { ProjectPerimeter } from "../../src/permission/project"
import { FileTime } from "../../src/file/time"
import { tmpdir } from "../fixture/fixture"

/**
 * SYMLINK ATTRAVERSO IL PERIMETRO.
 *
 * I due controlli confrontavano path LESSICALI: sia `Instance.containsPath`
 * (porta 1) sia la regola `allow("edit", ...)` che concede la scrittura
 * (porta 2). Con un symlink dentro la directory del programma che punta a
 * un'altra, entrambi dicevano "dentro" e il file finiva fuori perimetro.
 *
 * IL TEST DEVE POTER FALLIRE. La prima versione lasciava passare ogni `ask`
 * e poi catturava l'errore: restava verde anche con la difesa spenta, e non
 * misurava nulla (controprova del 2026-09-27). Qui ogni richiesta attraversa
 * il gate REALE (`PermissionNext.ask` col ruleset del perimetro), l'esito e'
 * annotato e visibile, e una denial non e' mai silenziosa.
 *
 * NESSUN repo git: e' la situazione REALE del bounty. Misurato il
 * 2026-09-27: `~/.cyberstrike/bugbounty` non ha un `.git` vicino, quindi
 * `diagnose()` restituisce worktree "/" e i path sono ASSOLUTI. Con un repo
 * git il confine di `external_directory` sarebbe l'intero repo, e il test
 * misurerebbe uno scenario che nel bounty non esiste.
 */

type Esito = { deny: number; allow: number; errore?: string }

function makeCtx(perimeter: ReturnType<typeof ProjectPerimeter.buildProjectRuleset>, esito: Esito) {
  return {
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
        esito.allow++
      } catch (e) {
        if (e instanceof PermissionNext.DeniedError) {
          esito.deny++
          throw e
        }
        esito.errore = String(e)
        throw e
      }
    },
  } as any
}

/** il perimetro del programma, costruito come fa `bb hunt` */
async function perimeterFor(project: string) {
  const diagnosis = await ProjectPerimeter.diagnose(project)
  return ProjectPerimeter.buildProjectRuleset(project, diagnosis.worktree)
}

/** due programmi distinti, con un symlink dentro il primo verso il secondo */
async function scenario() {
  const tmp = await tmpdir()
  const base = (tmp as any).path
  const project = path.join(base, "programs", "bcny")
  const other = path.join(base, "programs", "bcny-test")
  await mkdir(project, { recursive: true })
  await mkdir(other, { recursive: true })
  const link = path.join(project, "link")
  await symlink(other, link, "dir")
  return { tmp, project, other, link }
}

describe("symlink attraverso il perimetro", () => {
  test("CONTROLLO POSITIVO: scrivere dentro il perimetro passa e il file esiste", async () => {
    const { tmp, project } = await scenario()
    await using _t = tmp
    const esito: Esito = { deny: 0, allow: 0 }

    await Instance.provide({
      directory: project,
      fn: async () => {
        const c = makeCtx(await perimeterFor(project), esito)
        const target = path.join(project, "normale.txt")
        await (await WriteTool.init()).execute({ filePath: target, content: "ok" }, c)
        // se il file non esiste il test non misura niente: fallo esplicito
        expect({ esiste: existsSync(target), contenuto: existsSync(target) ? await readFile(target, "utf8") : null }).toEqual({
          esiste: true,
          contenuto: "ok",
        })
        expect(esito.deny).toBe(0)
      },
    })
  })

  test("write: il symlink verso un altro programma non scrive fuori", async () => {
    const { tmp, project, other, link } = await scenario()
    await using _t = tmp
    const esito: Esito = { deny: 0, allow: 0 }

    await Instance.provide({
      directory: project,
      fn: async () => {
        const c = makeCtx(await perimeterFor(project), esito)
        await (await WriteTool.init())
          .execute({ filePath: path.join(link, "rubato.txt"), content: "RUBATO" }, c)
          .catch((e) => {
            esito.errore = String(e)
          })

        const fuori = path.join(other, "rubato.txt")
        expect({
          fuori: existsSync(fuori),
          contenuto: existsSync(fuori) ? await readFile(fuori, "utf8") : null,
        }).toEqual({ fuori: false, contenuto: null })
        // e la denial deve essere reale e visibile
        expect(esito.errore ?? null).toContain("prevents you from using")
      },
    })
  })

  test("edit: il symlink verso un altro programma non scrive fuori", async () => {
    const { tmp, project, other, link } = await scenario()
    await using _t = tmp
    const esito: Esito = { deny: 0, allow: 0 }
    const fuori = path.join(other, "esistente.txt")
    await Bun.write(fuori, "prima")

    await Instance.provide({
      directory: project,
      fn: async () => {
        const c = makeCtx(await perimeterFor(project), esito)
        // `edit` pretende che il file sia stato letto (FileTime.assert). Senza
        // questo il test misurerebbe quel vincolo e non il perimetro: la
        // denial arriverebbe per il motivo sbagliato.
        await FileTime.read(c.sessionID, path.join(link, "esistente.txt"))
        // il path canonico e' quello su cui `edit` va a scrivere: registrarlo
        // evita che il test misuri il vincolo di lettura invece del perimetro
        await FileTime.read(c.sessionID, path.join(other, "esistente.txt"))
        await (await EditTool.init())
          .execute({ filePath: path.join(link, "esistente.txt"), oldString: "prima", newString: "dopo" }, c)
          .catch((e) => {
            esito.errore = String(e)
          })

        expect(await readFile(fuori, "utf8")).toBe("prima")
        expect(esito.errore ?? null).toContain("prevents you from using")
      },
    })
  })

  test("apply_patch: il symlink verso un altro programma non scrive fuori", async () => {
    const { tmp, project, other, link } = await scenario()
    await using _t = tmp
    const esito: Esito = { deny: 0, allow: 0 }

    await Instance.provide({
      directory: project,
      fn: async () => {
        const c = makeCtx(await perimeterFor(project), esito)
        const patch = [
          "*** Begin Patch",
          `*** Add File: ${path.join(link, "patched.txt")}`,
          "+PATCH",
          "*** End Patch",
        ].join("\n")

        await (await ApplyPatchTool.init())
          .execute({ patchText: patch } as any, c)
          .catch((e) => {
            esito.errore = String(e)
          })

        const fuori = path.join(other, "patched.txt")
        expect({
          fuori: existsSync(fuori),
          contenuto: existsSync(fuori) ? await readFile(fuori, "utf8") : null,
        }).toEqual({ fuori: false, contenuto: null })
        expect(esito.errore ?? null).toContain("prevents you from using")
      },
    })
  })

  test("CRITICO 1: parent inesistente SOTTO un symlink (apply_patch + mkdir -p)", async () => {
    const { tmp, project, other, link } = await scenario()
    await using _t = tmp
    const esito: Esito = { deny: 0, allow: 0 }

    await Instance.provide({
      directory: project,
      fn: async () => {
        const c = makeCtx(await perimeterFor(project), esito)
        // `newdir` non esiste: `realpath(parent)` fallisce e il codice presume
        // che verra' creata come directory REALE, ma `mkdir -p` segue `link`
        const patch = [
          "*** Begin Patch",
          `*** Add File: ${path.join(link, "newdir", "rubato.txt")}`,
          "+RUBATO",
          "*** End Patch",
        ].join("\n")

        await (await ApplyPatchTool.init())
          .execute({ patchText: patch } as any, c)
          .catch((e) => {
            esito.errore = String(e)
          })

        const fuori = path.join(other, "newdir", "rubato.txt")
        expect({
          fuori: existsSync(fuori),
          contenuto: existsSync(fuori) ? await readFile(fuori, "utf8") : null,
        }).toEqual({ fuori: false, contenuto: null })
      },
    })
  })

  // NOTA: questo caso passa ALSO a HEAD, quindi NON e' una prova che il fix
  // serva: `write` rifiutava gia' il symlink sul file. Resta come rete di
  // sicurezza contro una regressione futura, non come test che dimostra un
  // difetto corretto. Verificato con controprova il 2026-09-27.
  test("REGRESSIONE: symlink sul FILE stesso non sovrascrive un file esterno", async () => {
    const { tmp, project, other } = await scenario()
    await using _t = tmp
    const esito: Esito = { deny: 0, allow: 0 }
    const esterno = path.join(other, "victim.txt")
    await Bun.write(esterno, "before")
    // il symlink e' sul FILE finale, non sulla directory: risolvere solo il
    // parent lascia il path apparentemente interno
    await symlink(esterno, path.join(project, "victim.txt"), "file")

    await Instance.provide({
      directory: project,
      fn: async () => {
        const c = makeCtx(await perimeterFor(project), esito)
        await (await WriteTool.init())
          .execute({ filePath: path.join(project, "victim.txt"), content: "OVERWRITTEN" }, c)
          .catch((e) => {
            esito.errore = String(e)
          })

        expect(await readFile(esterno, "utf8")).toBe("before")
      },
    })
  })

  test("ALTO: apply_patch move scrive sul path lessicale invece del canonico", async () => {
    const { tmp, project, other, link } = await scenario()
    await using _t = tmp
    const esito: Esito = { deny: 0, allow: 0 }
    await Bun.write(path.join(project, "sorgente.txt"), "dati")

    await Instance.provide({
      directory: project,
      fn: async () => {
        const c = makeCtx(await perimeterFor(project), esito)
        const patch = [
          "*** Begin Patch",
          `*** Update File: ${path.join(project, "sorgente.txt")}`,
          `*** Move to: ${path.join(link, "spostato.txt")}`,
          "@@",
          "-dati",
          "+dati",
          "*** End Patch",
        ].join("\n")

        await (await ApplyPatchTool.init())
          .execute({ patchText: patch } as any, c)
          .catch((e) => {
            esito.errore = String(e)
          })

        // il perimetro deve BLOCCARE il move: nessuna scrittura fuori
        expect(existsSync(path.join(other, "spostato.txt"))).toBe(false)
      },
    })
  })

  test("CRITICO 3: symlink DANNEGGIATO non crea il file fuori perimetro", async () => {
    const { tmp, project, other } = await scenario()
    await using _t = tmp
    const esito: Esito = { deny: 0, allow: 0 }
    const fuori = path.join(other, "created.txt")
    // il link punta a un file che NON esiste: `realpath` su quel cammino
    // fallisce come per un semplice componente inesistente, ma `Bun.write`
    // lo segue lo stesso. Caso trovato dal 3o giro di verifica
    // (`deleg_f9dda4ce`) e riprodotto qui.
    await symlink(fuori, path.join(project, "dangling"), "file")

    await Instance.provide({
      directory: project,
      fn: async () => {
        const c = makeCtx(await perimeterFor(project), esito)
        await (await WriteTool.init())
          .execute({ filePath: path.join(project, "dangling"), content: "ESCAPED" }, c)
          .catch((e) => {
            esito.errore = String(e)
          })

        expect({
          fuori: existsSync(fuori),
          contenuto: existsSync(fuori) ? await readFile(fuori, "utf8") : null,
        }).toEqual({ fuori: false, contenuto: null })
        // la prova forte e' il file fuori assente: se il tool fosse rotto
        // fallirebbe comunque, ma il CONTROLLO POSITIVO in cima dimostra
        // che il tool funziona nello stesso scenario
      },
    })
  })
})
