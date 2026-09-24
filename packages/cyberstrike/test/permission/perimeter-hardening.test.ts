import { describe, expect, test } from "bun:test"
import { ProjectPerimeter } from "../../src/permission/project"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"

// Test dei buchi trovati dalla verifica avversariale indipendente (subagent).
// Ogni test qui corrisponde a un attacco che PRIMA passava e ora è chiuso.

describe("perimetro — metacaratteri nel nome del programma", () => {
  test("globMeta riconosce i metacaratteri di Wildcard.match", () => {
    expect(ProjectPerimeter.globMeta("bcny")).toBe(false)
    expect(ProjectPerimeter.globMeta("my-program_v2")).toBe(false)
    expect(ProjectPerimeter.globMeta("bcny*")).toBe(true)
    expect(ProjectPerimeter.globMeta("bcny?")).toBe(true)
    expect(ProjectPerimeter.globMeta("bc[ny]")).toBe(true)
  })

  test("un nome con metacaratteri è rifiutato: il pattern allow coprirebbe di più", async () => {
    // Senza il controllo, il nome "bcny*" genererebbe il pattern
    // "/home/.../programs/bcny*/*" che con Wildcard.match (= regex `.*`)
    // coprirebbe anche "bcny-QUALSIASI" e le sue sottodirectory.
    const d = await ProjectPerimeter.diagnose("/home/marco/.cyberstrike/bugbounty/programs/bcny*x")
    expect(d.risk).toBe("unsafe-program-name")
    expect(ProjectPerimeter.isSafe(d)).toBe(false)
  })

  test("un nome normale NON è rifiutato", async () => {
    const d = await ProjectPerimeter.diagnose("/home/marco/.cyberstrike/bugbounty/programs/bcny")
    expect(d.risk).not.toBe("unsafe-program-name")
    expect(ProjectPerimeter.isSafe(d)).toBe(true)
  })

  test("buildProjectRuleset lancia su un percorso con metacaratteri (difesa in profondità)", () => {
    expect(() => ProjectPerimeter.buildProjectRuleset("/tmp/glob*meta/prog", "/tmp/glob*meta")).toThrow(
      /glob metacharacters/,
    )
  })
})

describe("perimetro — l'utente non può rendere permanente un permesso oltre il confine", () => {
  test("un `always` con pattern `*` viene filtrato: il perimetro regge dopo il click", async () => {
    // write.ts/edit.ts chiedono `always: ["*"]`. Un click "sempre" su una
    // scrittura INTERNA aggiungerebbe {edit,*,allow} e `evaluate` (findLast) lo
    // farebbe vincere su tutto: il perimetro sparirebbe per il resto della
    // sessione. Il motore deve filtrare i pattern troppo ampi quando il ruleset
    // attivo contiene un deny sulla stessa permission.
    const sessionID = "ses_perim_" + Math.random().toString(36).slice(2)
    const ruleset = ProjectPerimeter.buildProjectRuleset("/tmp/GP/PROGETTO", "/tmp")

    await Instance.provide({
      directory: "/tmp/GP/PROGETTO",
      fn: async () => {
        // 1) l'utente approva "sempre" una scrittura interna
        const primo = PermissionNext.ask({
          id: "per_test_interno",
          sessionID,
          permission: "edit",
          patterns: ["GP/PROGETTO/dentro.txt"],
          always: ["*"],
          metadata: {},
          ruleset,
        })
        await PermissionNext.reply({ requestID: "per_test_interno", reply: "always" })
        await primo

        // 2) ora una scrittura FUORI: `ask` deve ancora lanciare DeniedError,
        //    cioè il confine non è stato cancellato dall'always.
        //    (ask lancia in modo sincrono, non ritorna una promise respinta)
        expect(() =>
          PermissionNext.ask({
            id: "per_test_esterno",
            sessionID,
            permission: "edit",
            patterns: ["/etc/passwd"],
            always: ["*"],
            metadata: {},
            ruleset,
          }),
        ).toThrow(/prevents you from using/)

        // 3) e una scrittura DENTRO deve continuare a passare senza ask
        await expect(
          Promise.resolve(
            PermissionNext.ask({
              id: "per_test_dentro2",
              sessionID,
              permission: "edit",
              patterns: ["GP/PROGETTO/altro.txt"],
              always: ["*"],
              metadata: {},
              ruleset,
            }),
          ),
        ).resolves.toBeUndefined()
      },
    })
  })
})