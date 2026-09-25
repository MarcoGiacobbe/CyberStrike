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

        // 2) ora una scrittura FUORI: `ask` deve ancora rifiutare, cioè il
        //    confine non è stato cancellato dall'always. `ask` NON lancia in
        //    modo sincrono: ritorna una promise respinta — e `expect(() =>
        //    promise).toThrow()` passa comunque a vuoto, quindi va atteso.
        await expect(
          PermissionNext.ask({
            id: "per_test_esterno",
            sessionID,
            permission: "edit",
            patterns: ["/etc/passwd"],
            always: ["*"],
            metadata: {},
            ruleset,
          }),
        ).rejects.toThrow(/prevents you from using/)

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
describe("perimetro — V8.2: una concessione salvata non batte il deny", () => {
  test("`approved` {edit,*,allow} su una permission NEGATA viene ignorata", async () => {
    // Il canale interattivo filtrava i pattern `*`, ma `approved` è
    // PERSISTITO su DB e riletto a ogni sessione: una riga {edit,*,allow}
    // messa li' (o scritta a mano) scavalcava il deny con `findLast`.
    // Il filtro ora sta in `evaluate`, quindi vale per OGNI canale.
    const sessionID = "ses_seed_" + Math.random().toString(36).slice(2)
    const ruleset = ProjectPerimeter.buildProjectRuleset("/tmp/GP/PROGETTO", "/tmp")

    await Instance.provide({
      directory: "/tmp/GP/PROGETTO",
      fn: async () => {
        await expect(
          PermissionNext.ask({
            id: "per_seed_edit",
            sessionID,
            permission: "edit",
            patterns: ["/etc/passwd"],
            always: ["*"],
            metadata: {},
            ruleset,
          }),
        ).rejects.toThrow()
      },
    })
  })

  test("`evaluate` ignora un allow che copre tutto quando esiste un deny", () => {
    const ruleset = ProjectPerimeter.buildProjectRuleset("/tmp/GP/PROGETTO", "/tmp")
    const seeded = [{ permission: "edit", pattern: "*", action: "allow" } as const]
    expect(PermissionNext.evaluate("edit", "/etc/passwd", ruleset, seeded).action).toBe("deny")
  })

  test("controprova: FUORI perimetro una concessione ampia vale ancora", () => {
    const seeded = [{ permission: "edit", pattern: "/tmp/*", action: "allow" } as const]
    expect(PermissionNext.evaluate("edit", "/tmp/x.txt", [], seeded).action).toBe("allow")
  })
})

describe("perimetro — V8.1: `always` di famiglia su un comando non apre il perimetro", () => {
  test("un allow su `python3 *` non rende permanente la scrittura opaca", () => {
    // `bash_unresolved` ha pattern che sono TESTO DI COMANDO, non path: una
    // famiglia (`python3 *`) non è confinabile a una directory. Dopo un click
    // "sempre" su un python3 innocuo, la scrittura fuori progetto non chiedeva
    // piu' nulla. Il perimetro la mantiene in `ask`.
    const ruleset = ProjectPerimeter.buildProjectRuleset("/tmp/GP/PROGETTO", "/tmp")
    const seeded = [{ permission: "bash_unresolved", pattern: "python3 *", action: "allow" } as const]
    const r = PermissionNext.evaluate("bash_unresolved", 'python3 -c "open(\'/etc/x\',\'w\')"', ruleset, seeded)
    expect(r.action).toBe("ask")
  })

  test("controprova: FUORI perimetro la stessa concessione è rispettata", () => {
    const seeded = [{ permission: "bash_unresolved", pattern: "python3 *", action: "allow" } as const]
    expect(PermissionNext.evaluate("bash_unresolved", 'python3 -c "print(1)"', [], seeded).action).toBe("allow")
  })
})

describe("perimetro — B14: progetto coincidente con la radice del repo", () => {
  test("buildProjectRuleset rifiuta invece di emettere un pattern allow `/*`", () => {
    // `path.relative(dir, dir)` = "": il pattern diventava "/*", che con
    // Wildcard.match (`\/.*`) copre OGNI path assoluto, /etc/passwd incluso.
    // Il vecchio test lo credeva inerte perché provava solo path relativi.
    expect(() => ProjectPerimeter.buildProjectRuleset("/tmp/x", "/tmp/x")).toThrow(/cannot be perimetrated/)
  })

  test("l'attacco che prima riusciva: edit su path ASSOLUTO", () => {
    const bad = ProjectPerimeter.buildProjectRuleset("/tmp/x", undefined)
    // con worktree undefined il relativo NON è vuoto: il ruleset è valido
    expect(PermissionNext.evaluate("edit", "/etc/passwd", bad).action).toBe("deny")
  })
})

describe("V8 — il matching non è letterale (P1/P2/P4)", () => {
  // Il confine è riconosciuto dal MARCATORE esplicito (`boundary: true`), non
  // dalla forma del ruleset: senza, un confine espresso con `ask` al posto del
  // `deny` non veniva riconosciuto e tutti i filtri saltavano in silenzio.
  const PERI: PermissionNext.Ruleset = [
    { permission: "edit", pattern: "*", action: "deny", boundary: true },
    { permission: "edit", pattern: "/progetto/*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "deny", boundary: true },
    { permission: "bash", pattern: "*", action: "ask", boundary: true },
    { permission: "bash_unresolved", pattern: "*", action: "ask", boundary: true },
  ]

  test("P1: un pattern quasi-tutto non batte il deny", () => {
    // `Wildcard.match("*", "?????*")` è false, ma `?????*` diventa `^.{5,}$` e
    // copre comunque qualunque stringa di 5+ caratteri: il deny veniva scavalcato.
    for (const pattern of ["?????*", "??????*", "*/*", "**/*", "/etc/*", "/etc/passwd", "*passwd*"]) {
      const r = PermissionNext.evaluate("edit", "/etc/passwd", PERI, [{ permission: "edit", pattern, action: "allow" }])
      expect(r.action).toBe("deny")
    }
  })

  test("P1: sotto un confine, la concessione esterna su un'area governata perde", () => {
    // Il confine è l'unica autorità sulle aree che governa (edit,
    // external_directory): una `allow` da config/DB su `edit` non può
    // riaprire ciò che il confine chiude — è proprio il buco P1/P2.
    const r = PermissionNext.evaluate("edit", "/progetto/x.txt", PERI, [
      { permission: "edit", pattern: "/progetto/*", action: "allow" },
    ])
    expect(r.action).toBe("deny")
  })

  test("controprova: su un'area NON governata dal confine, la concessione vale", () => {
    // Il filtro è limitato all'allowlist: `read` non è un'area di scrittura, e
    // la concessione dell'utente resta valida ("l'ultima regola vince").
    const r = PermissionNext.evaluate("read", "/etc/shadow", PERI, [
      { permission: "read", pattern: "/etc/*", action: "allow" },
    ])
    expect(r.action).toBe("allow")
  })

  test("controprova: le concessioni DEL confine restano (sono il confine)", () => {
    const conConfine: PermissionNext.Ruleset = [
      { permission: "edit", pattern: "*", action: "deny", boundary: true },
      { permission: "edit", pattern: "/progetto/*", action: "allow", boundary: true },
    ]
    expect(PermissionNext.evaluate("edit", "/progetto/x.txt", conConfine).action).toBe("allow")
  })

  test("P2: una permission con jolly non scavalca il confine", () => {
    // `COMMAND_PERMISSIONS.has("bash*")` era false: `{bash*,*,allow}` apriva
    // bash E bash_unresolved. `{edit*,*,allow}` non trovava il deny su `edit`
    // perché il confronto era per uguaglianza di stringa.
    const casi: [string, string][] = [
      ["bash", "python3 /tmp/x.py"],
      ["bash_unresolved", "python3 /tmp/x.py"],
      ["edit", "/etc/passwd"],
      ["external_directory", "/etc/*"],
    ]
    for (const [permission, pattern] of casi) {
      const r = PermissionNext.evaluate(permission, pattern, PERI, [
        { permission: `${permission}*`, pattern: "*", action: "allow" },
      ])
      expect(r.action).not.toBe("allow")
    }
  })

  test("P2: il catch-all {*,*,allow} non apre nulla", () => {
    for (const [permission, pattern] of [
      ["edit", "/etc/passwd"],
      ["bash", "python3 /tmp/x.py"],
      ["bash_unresolved", "python3 /tmp/x.py"],
    ] as [string, string][]) {
      const r = PermissionNext.evaluate(permission, pattern, PERI, [{ permission: "*", pattern: "*", action: "allow" }])
      expect(r.action).not.toBe("allow")
    }
  })

  test("P4: il filtro non tocca aree fuori dall'allowlist (l'override {question:allow})", () => {
    // Prima l'override di `agent.ts` veniva ucciso quando il ruleset conteneva un
    // deny su `question` (default dell'agente): il tool question restava morto.
    const ruleset: PermissionNext.Ruleset = [
      ...PERI,
      { permission: "question", pattern: "*", action: "deny" },
    ]
    const r = PermissionNext.evaluate("question", "*", ruleset, [{ permission: "question", pattern: "*", action: "allow" }])
    expect(r.action).toBe("allow")
  })

  test("il confine è riconosciuto dal marcatore, non dalla forma del ruleset", () => {
    // Un confine che NON usa `deny` su external_directory (la forma che
    // `isPerimeter` cercava prima): senza marcatore non veniva riconosciuto e i
    // filtri saltavano in silenzio. Qui il confine è `ask` su due aree.
    const senzaForma: PermissionNext.Ruleset = [
      { permission: "edit", pattern: "*", action: "ask", boundary: true },
      { permission: "bash", pattern: "*", action: "ask", boundary: true },
    ]
    // La famiglia bash non diventa permanente (famiglia su comando).
    expect(
      PermissionNext.evaluate("bash", "python3 /tmp/x.py", senzaForma, [
        { permission: "bash", pattern: "python3 *", action: "allow" },
      ]).action,
    ).not.toBe("allow")

    // E la controprova: senza il marcatore le stesse regole non attivano nulla.
    const senzaMarcatore: PermissionNext.Ruleset = [
      { permission: "edit", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "*", action: "ask" },
    ]
    expect(
      PermissionNext.evaluate("bash", "python3 /tmp/x.py", senzaMarcatore, [
        { permission: "bash", pattern: "python3 *", action: "allow" },
      ]).action,
    ).toBe("allow")
  })

  test("senza marcatore il ruleset resta una preferenza dell'utente", () => {
    // "L'ultima regola vince": non si cambia la semantica di un ruleset normale.
    const normale: PermissionNext.Ruleset = [
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "allow" },
    ]
    expect(PermissionNext.evaluate("edit", "/etc/passwd", normale).action).toBe("allow")
  })
})
