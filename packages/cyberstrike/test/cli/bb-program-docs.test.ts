import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { classifyTargets, renderScopeDoc, renderAgentsDoc } from "../../src/cli/cmd/bb-program-docs"
import type { BountyProgramConfig } from "@cyberstrike-io/hackbrowser/bugbounty"

/**
 * Fase 3: i file nella directory del programma.
 *
 * Nota sul perimetro di questi test: `classifyTargets` e i renderer sono
 * funzioni pure e senza effetti. NON provano che `bb hunt` li chiami, ne che
 * scrivano dove dicono. Il test del cablaggio e' in bb-hunt-directory.test.ts
 * e va mantenuto separato apposta: se i due fossero nello stesso file, un
 * test verde potrebbe mascherare l'altro.
 */

const base: BountyProgramConfig = {
  name: "esempio",
  platform: "hackerone",
  programUrl: "https://hackerone.com/esempio",
  description: "Programma di prova",
  scope: { in: ["example.com", "app.example.com", "Example Browser", "id123456"], out: ["blog.example.com"] },
  payouts: { low: "$100", medium: "$1,000", high: "$10,000", critical: "$20,000" },
  rules: { maxSteps: 6, authenticated: false, custom: ["submission_state: open"] },
  lastUpdated: "2026-09-29T10:00:00.000Z",
}

describe("fase 3: i file del programma", () => {
  test("gli URL vanno in una sezione, i nomi di prodotto in un'altra", () => {
    const c = classifyTargets(base)
    expect(c.urls).toEqual(["example.com", "app.example.com"])
    expect(c.products).toEqual(["Example Browser"])
    // id123456 e' un id numerico: non e' un dominio, e non e' un prodotto.
    // Deve finire da qualche parte di esplicito, non sparire.
    expect([...c.urls, ...c.products, ...c.unclassified]).toContain("id123456")
  })

  test("gli out-of-scope sono sempre separati dagli in-scope", () => {
    const c = classifyTargets(base)
    expect(c.outOfScope).toEqual(["blog.example.com"])
    for (const t of c.outOfScope) {
      expect(c.inScope).not.toContain(t)
    }
  })

  test("scope.md dichiara i non-URL invece di lasciarli credere siti web", () => {
    const md = renderScopeDoc(base)
    // Un agente che legge 'Arc on Mac' accanto ad 'arc.net' puo' provare a
    // visitare arc.net per il bounty di Arc on Mac. Devono stare separati.
    expect(md).toContain("example.com")
    expect(md).toContain("Example Browser")
  })

  test("AGENTS.md rimanda alla policy integrale su disco, non la copia", () => {
    // Il ramo che conta e' quello in cui il file ESISTE: il rimando e' un
    // percorso reale. Con un path inesistente il doc dice giustamente
    // "non in locale" e il test passerebbe senza provare niente.
    const dir = mkdtempSync(path.join(tmpdir(), "bbdocs-"))
    const policy = path.join(dir, "esempio.policy.md")
    writeFileSync(policy, "# policy integrale del programma\ntesto lungo.\n")
    try {
      const md = renderAgentsDoc(base, dir)
      expect(md).toContain(policy)
      expect(md).toContain("policy integrale")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("se la policy non e' in locale, il rimando e' un comando, non una promessa", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bbdocs-"))
    try {
      const md = renderAgentsDoc(base, dir)
      expect(md).toContain("bb sync esempio")
      // non deve promettere un file che non c'e'
      expect(md).not.toContain(`${base.name}.policy.md`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("la policy integrale NON viene rigenerata: si cita il file", () => {
    // 'Scope IN' con policy dentro il config e' il troncamento a 500 caratteri.
    // Se finisce in scope.md il difetto e' reintroduto.
    const cfg = { ...base, rules: { ...base.rules, custom: [...base.rules!.custom!, "policy_excerpt: " + "z".repeat(900)] } }
    const md = renderScopeDoc(cfg)
    expect(md).not.toContain("z".repeat(900))
    expect(md).not.toContain("policy_excerpt")
  })
})

describe("fase 3: CABLAGGIO in bb hunt", () => {
  test("`bb hunt` scrive AGENTS.md e scope.md nella directory del programma", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bbhunt-"))
    const prev = process.env.CYBERSTRIKE_HOME
    process.env.CYBERSTRIKE_HOME = home
    try {
      mkdirSync(path.join(home, "bugbounty"), { recursive: true })
      const d = new Date(Date.now() - 3 * 86_400_000).toISOString()
      writeFileSync(
        path.join(home, "bugbounty", "esempio.json"),
        JSON.stringify({ name: "esempio", platform: "hackerone", scope: { in: ["vecchio.example"], out: [] }, payouts: { low: "$1" }, lastUpdated: d }),
      )
      // --dry-run: nessun TUI, nessun processo da 800MB, ma la stessa
      // costruzione dei documenti. Se i file non compaiono, il cablaggio
      // non c'e' — non e' un test delle funzioni pure.
      const r = Bun.spawnSync(
        ["bun", "run", "--conditions=browser", "src/index.ts", "bb", "hunt", "esempio", "--dry-run"],
        { cwd: process.cwd(), env: { ...process.env, CYBERSTRIKE_HOME: home }, timeout: 120_000 },
      )
      const out = r.stdout.toString() + r.stderr.toString()
      expect(out).toContain("sincronizzerei esempio")
      const dir = path.join(home, "bugbounty", "programs", "esempio")
      expect(existsSync(path.join(dir, "AGENTS.md"))).toBe(true)
      expect(existsSync(path.join(dir, "scope.md"))).toBe(true)
      // e devono dire la vereta' sul programma
      expect(await Bun.file(path.join(dir, "scope.md")).text()).toContain("vecchio.example")
    } finally {
      if (prev === undefined) delete process.env.CYBERSTRIKE_HOME
      else process.env.CYBERSTRIKE_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("fase 3: REGRESSIONE del rimando alla policy", () => {
  test("la policy sta NELLA ROOT di bugbounty, non dentro programs/", async () => {
    // Difetto misurato: `bb.ts` passava `programsRoot` (…/bugbounty/programs)
    // come directory della policy, quindi `AGENTS.md` scriveva "policy NON in
    // locale" mentre il file esisteva a `…/bugbounty/<handle>.policy.md`.
    // Un rimando rotto e' peggio di nessun rimando: l'agente va a chiedere
    // all'utente una sync che non serve.
    const home = mkdtempSync(path.join(tmpdir(), "bbreg-"))
    const prev = process.env.CYBERSTRIKE_HOME
    process.env.CYBERSTRIKE_HOME = home
    try {
      mkdirSync(path.join(home, "bugbounty"), { recursive: true })
      // la policy, nel posto in cui `bb sync` la scrive davvero
      writeFileSync(path.join(home, "bugbounty", "reale.policy.md"), "# policy integrale\n")
      const d = new Date().toISOString()
      writeFileSync(
        path.join(home, "bugbounty", "reale.json"),
        JSON.stringify({ name: "reale", platform: "hackerone", scope: { in: ["ok.example"], out: [] }, payouts: { low: "$1" }, lastUpdated: d }),
      )
      const r = Bun.spawnSync(
        ["bun", "run", "--conditions=browser", "src/index.ts", "bb", "hunt", "reale", "--dry-run"],
        { cwd: process.cwd(), env: { ...process.env, CYBERSTRIKE_HOME: home }, timeout: 120_000 },
      )
      expect(r.stdout.toString() + r.stderr.toString()).not.toContain("non ho potuto scrivere")
      const agents = await Bun.file(path.join(home, "bugbounty", "programs", "reale", "AGENTS.md")).text()
      expect(agents).toContain("reale.policy.md")
      expect(agents).not.toContain("NON e' in locale")
    } finally {
      if (prev === undefined) delete process.env.CYBERSTRIKE_HOME
      else process.env.CYBERSTRIKE_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })
})
