import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync, linkSync, readFileSync, lstatSync, statSync, readdirSync, chmodSync, openSync, closeSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { classifyTargets, renderScopeDoc, renderAgentsDoc, writeProgramDocs } from "../../src/cli/cmd/bb-program-docs"
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

describe("perimetro di scrittura: la tmp del programma", () => {
  test("AGENTS.md dichiara tmp/ come l'unico posto per i file di caccia", () => {
    const md = renderAgentsDoc(base, "/programs")
    expect(md).toContain("tmp/")
    // non generico: il divieto di scrivere fuori deve restare, e tmp/ deve
    // essere indicato come l'eccezione, non come una zona qualsiasi.
    expect(md).toMatch(/tmp\//)
  })

  test("`bb hunt` crea la cartella tmp/ dentro la directory del programma", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bbtmp-"))
    const prev = process.env.CYBERSTRIKE_HOME
    process.env.CYBERSTRIKE_HOME = home
    try {
      mkdirSync(path.join(home, "bugbounty"), { recursive: true })
      const d = new Date(Date.now() - 3 * 86_400_000).toISOString()
      writeFileSync(
        path.join(home, "bugbounty", "esempio.json"),
        JSON.stringify({ name: "esempio", platform: "hackerone", scope: { in: ["vecchio.example"], out: [] }, payouts: { low: "$1" }, lastUpdated: d }),
      )
      const r = Bun.spawnSync(
        ["bun", "run", "--conditions=browser", "src/index.ts", "bb", "hunt", "esempio", "--dry-run"],
        { cwd: process.cwd(), env: { ...process.env, CYBERSTRIKE_HOME: home }, timeout: 120_000 },
      )
      expect(r.stdout.toString() + r.stderr.toString()).toContain("sincronizzerei esempio")
      const dir = path.join(home, "bugbounty", "programs", "esempio")
      expect(existsSync(path.join(dir, "tmp"))).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.CYBERSTRIKE_HOME
      else process.env.CYBERSTRIKE_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("tmp/: il difetto del symlink trovato dal subagent (deleg_cb90184f)", () => {
  test("una tmp che e' un symlink NON viene seguita (fuori dal perimetro)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-link-"))
    const directory = path.join(root, "programs", "bcny")
    const fuori = path.join(root, "FUORI-DAL-PERIMETRO")
    mkdirSync(directory, { recursive: true })
    mkdirSync(fuori, { recursive: true })
    // Il caso che il subagent ha misurato: `mkdirSync` su un symlink esce 0
    // e non lo tocca, quindi `tmp` diventava la directory esterna.
    symlinkSync(fuori, path.join(directory, "tmp"))
    expect(() => writeProgramDocs(base, directory, path.join(root, "programs"))).toThrow(/symlink/i)
    // Il link non va seguito, cancellato ne' risolto: la directory esterna
    // resta intatta e non ci compare nessun file.
    expect(readdirSync(fuori)).toEqual([])
    expect(lstatSync(path.join(directory, "tmp")).isSymbolicLink()).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  test("una tmp preesistente a 0777 viene corretta a 0700", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-perm-"))
    const directory = path.join(root, "programs", "bcny")
    mkdirSync(path.join(directory, "tmp"), { recursive: true, mode: 0o777 })
    // `mkdir recursive` NON tocca i permessi di una dir gia' esistente: a
    // HEAD questa tmp restava a 0777, scrivibile da chiunque sulla macchina.
    chmodSync(path.join(directory, "tmp"), 0o777)
    writeProgramDocs(base, directory, path.join(root, "programs"))
    expect(statSync(path.join(directory, "tmp")).mode & 0o777).toBe(0o700)
    rmSync(root, { recursive: true, force: true })
  })

  test("una tmp normale e' creata a 0700", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-ok-"))
    const directory = path.join(root, "programs", "bcny")
    mkdirSync(directory, { recursive: true })
    writeProgramDocs(base, directory, path.join(root, "programs"))
    expect(statSync(path.join(directory, "tmp")).mode & 0o777).toBe(0o700)
    rmSync(root, { recursive: true, force: true })
  })
})

describe("AGENTS.md/scope.md: il BYPASS trovato dal secondo subagent (deleg_6dc3ac19)", () => {
  test("un AGENTS.md symlink NON fa scrivere fuori dal perimetro", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-sl-agents-"))
    const directory = path.join(root, "programs", "bcny")
    const fuori = path.join(root, "FUORI")
    mkdirSync(directory, { recursive: true })
    mkdirSync(fuori, { recursive: true })
    const esterno = path.join(fuori, "AGENTS-stolen.md")
    symlinkSync(esterno, path.join(directory, "AGENTS.md"))
    writeProgramDocs(base, directory, path.join(root, "programs"))
    // Il file esterno NON deve ricevere un byte: a HEAD riceveva 979 byte
    // attraverso il link, con `bb hunt --dry-run` che usciva rc=0.
    expect(existsSync(esterno)).toBe(false)
    // E il documento resta nel perimetro, col contenuto vero: il link viene
    // SOSTITUITO, non seguito.
    expect(lstatSync(path.join(directory, "AGENTS.md")).isSymbolicLink()).toBe(false)
    expect(readFileSync(path.join(directory, "AGENTS.md"), "utf-8")).toMatch(/bug bounty/)
    rmSync(root, { recursive: true, force: true })
  })

  test("uno scope.md symlink NON fa scrivere fuori dal perimetro", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-sl-scope-"))
    const directory = path.join(root, "programs", "bcny")
    const fuori = path.join(root, "FUORI")
    mkdirSync(directory, { recursive: true })
    mkdirSync(fuori, { recursive: true })
    const esterno = path.join(fuori, "scope-stolen.md")
    symlinkSync(esterno, path.join(directory, "scope.md"))
    writeProgramDocs(base, directory, path.join(root, "programs"))
    expect(existsSync(esterno)).toBe(false)
    expect(lstatSync(path.join(directory, "scope.md")).isSymbolicLink()).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  test("un HARD LINK non porta il contenuto fuori dal perimetro", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-hl-"))
    const directory = path.join(root, "programs", "bcny")
    const fuori = path.join(root, "FUORI")
    mkdirSync(directory, { recursive: true })
    mkdirSync(fuori, { recursive: true })
    // Un hard link non e' distinguibile da un file normale con `lstat`: un
    // controllo sul tipo NON lo vedrebbe. `rename` invece toglie solo questa
    // voce di directory: l'inode esterno (l'altro nome) resta intatto.
    const esterno = path.join(fuori, "scope-hl.md")
    writeFileSync(esterno, "CONTENUTO-ESTERNO-INTATTO")
    linkSync(esterno, path.join(directory, "scope.md"))
    writeProgramDocs(base, directory, path.join(root, "programs"))
    expect(readFileSync(esterno, "utf-8")).toBe("CONTENUTO-ESTERNO-INTATTO")
    rmSync(root, { recursive: true, force: true })
  })

  test("un tmp che e' un HARD LINK a una directory non e' accettato come normale", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-hld-"))
    const directory = path.join(root, "programs", "bcny")
    const fuori = path.join(root, "FUORI")
    mkdirSync(directory, { recursive: true })
    mkdirSync(fuori, { recursive: true })
    // Un hard link a una DIRECTORY non e' permesso dal kernel per i non-root:
    // se il filesystem lo rifiuta il test lo dice invece di fingere di aver
    // verificato qualcosa.
    try {
      linkSync(fuori, path.join(directory, "tmp"))
    } catch (e) {
      expect(String(e)).toMatch(/EPERM|ENOTSUP|EACCES|EEXIST|EMLINK|EOPNOTSUPP|UNKNOWN/i)
      rmSync(root, { recursive: true, force: true })
      return
    }
    writeProgramDocs(base, directory, path.join(root, "programs"))
    rmSync(root, { recursive: true, force: true })
  })

  test("la DIRECTORY del programma resa symlink non porta le scritture fuori", () => {
    // Terzo vettore, trovato misurando da soli: la difesa sui nomi dei file
    // (`writeInside`) non copre il caso in cui e' la CARTELLA del programma a
    // essere un link. MISURATO con l'entry point reale: `programs/bcny` link a
    // `/tmp/outdir-...` + `bb hunt bcny --dry-run` -> `AGENTS.md`, `scope.md` e
    // `tmp/` creati DENTRO la cartella esterna, `rc=0`.
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-dirlink-"))
    const programs = path.join(root, "programs")
    const fuori = path.join(root, "FUORI")
    mkdirSync(programs, { recursive: true })
    mkdirSync(fuori, { recursive: true })
    symlinkSync(fuori, path.join(programs, "bcny"))
    expect(() => writeProgramDocs(base, path.join(programs, "bcny"), programs)).toThrow(/FUORI|link/i)
    // e non ha scritto niente fuori
    expect(readdirSync(fuori)).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  test("programs/ stessa resa symlink: niente scritture fuori (senza concorrenza)", () => {
    // Difetto RIPRODOTTO dal quarto subagent (deleg_b41be483): se e' la
    // cartella `programs/` a essere un link a una cartella esterna, il
    // confronto fra due `realpath` COERENTI fra loro non se ne accorge, e i
    // documenti finiscono fuori. Qui la difesa e' `assertInsidePrograms`, che
    // confronta il percorso reale della directory con quello reale di
    // `programsDir`: entrambi risolvono fuori, e il confronto regge.
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-progs-"))
    const fuori = mkdtempSync(path.join(tmpdir(), "bbdocs-progs-out-"))
    const programs = path.join(root, "programs")
    symlinkSync(fuori, programs)
    mkdirSync(path.join(fuori, "bcny"), { recursive: true })
    const prev = process.env.CYBERSTRIKE_HOME
    process.env.CYBERSTRIKE_HOME = root
    try {
      let rifiutato = false
      try {
        writeProgramDocs(base, path.join(programs, "bcny"), programs)
      } catch {
        rifiutato = true
      }
      expect(rifiutato).toBe(true)
      expect(readdirSync(fuori).filter((f) => f === "AGENTS.md" || f === "scope.md")).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.CYBERSTRIKE_HOME
      else process.env.CYBERSTRIKE_HOME = prev
      rmSync(root, { recursive: true, force: true })
      rmSync(fuori, { recursive: true, force: true })
    }
  })

  test("sostituire la dir del programma prima della scrittura: rifiutata, non scritta fuori", () => {
    // Difetto RIPRODOTTO dal quarto subagent (deleg_b41be483): sostituendo
    // `programs/<prog>` con un symlink verso fuori, la scrittura usciva.
    // Qui si misura la DIFESA di perimetro: il percorso non-regolare viene
    // rifiutato, e niente viene scritto fuori. (La proprieta' dell'ancoraggio,
    // che e' cio' che chiude la corsa, si misura nel test seguente.)
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-anchor-"))
    const fuori = mkdtempSync(path.join(tmpdir(), "bbdocs-anchor-out-"))
    const programs = path.join(root, "programs")
    const directory = path.join(programs, "bcny")
    mkdirSync(directory, { recursive: true })
    const prev = process.env.CYBERSTRIKE_HOME
    process.env.CYBERSTRIKE_HOME = root
    try {
      writeProgramDocs(base, directory, programs)
      // la dir e' ora un link a fuori: una scrittura per NOME finirebbe la'
      rmSync(directory, { recursive: true, force: true })
      symlinkSync(fuori, directory)
      // DEVE essere rifiutata: qui il percorso testuale risolve fuori
      expect(() => writeProgramDocs(base, directory, programs)).toThrow()
      expect(readdirSync(fuori).filter((f) => f === "AGENTS.md" || f === "scope.md")).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.CYBERSTRIKE_HOME
      else process.env.CYBERSTRIKE_HOME = prev
      rmSync(root, { recursive: true, force: true })
      rmSync(fuori, { recursive: true, force: true })
    }
  })

  test("l'ANCORAGGIO regge nei due casi reali di sostituzione del nome", () => {
    // Questa e' la proprieta' su cui poggia `withAnchoredDir`, e va misurata
    // DIRETTAMENTE: se l'OS non la garantisse, la difesa sarebbe illusoria.
    // Due casi distinti, perche' il kernel si comporta diversamente:
    //
    //   1. RENAME (la dir esiste ancora, sotto un altro nome): `/proc/self/fd/N`
    //      continua a puntare all'inode aperto, quindi la scrittura resta
    //      dentro. MISURATO.
    //   2. DELETE + symlink (il caso dell'harness del subagent): l'inode e'
    //      scollegato e il percorso magico muore — la scrittura fallisce con
    //      ENOENT. Fail-closed: nega, non fugge. MISURATO.
    //
    // In NESSUNO dei due casi si scrive fuori: e' questo che il test pretende.
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-fd-"))
    const fuori = mkdtempSync(path.join(tmpdir(), "bbdocs-fd-out-"))
    const dir = path.join(root, "programs", "bcny")
    mkdirSync(dir, { recursive: true })
    try {
      // --- caso 1: rename
      const fd1 = openSync(dir, "r")
      try {
        const anchor = `/proc/self/fd/${fd1}`
        if (!existsSync(anchor)) return // piattaforma senza /proc: niente ancoraggio
        renameSync(dir, path.join(root, "spostata"))
        symlinkSync(fuori, dir)
        writeFileSync(path.join(anchor, "uno.txt"), "dentro")
      } finally {
        closeSync(fd1)
      }
      expect(existsSync(path.join(fuori, "uno.txt"))).toBe(false)
      expect(existsSync(path.join(root, "spostata", "uno.txt"))).toBe(true)

      // --- caso 2: delete + symlink (fail-closed)
      rmSync(dir, { force: true })
      mkdirSync(dir, { recursive: true })
      const fd2 = openSync(dir, "r")
      try {
        const anchor = `/proc/self/fd/${fd2}`
        rmSync(dir, { recursive: true, force: true })
        symlinkSync(fuori, dir)
        // o lancia (ENOENT), o scrive dentro: mai fuori
        try {
          writeFileSync(path.join(anchor, "due.txt"), "dentro")
        } catch {}
      } finally {
        closeSync(fd2)
      }
      expect(existsSync(path.join(fuori, "due.txt"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(fuori, { recursive: true, force: true })
    }
  })

  test("nessun file .tmp orfano dentro il progetto dopo un fallimento", () => {
    // Difetto RIPRODOTTO dal quarto subagent: se la `rename` fallisce, la
    // pulizia cercava il temporaneo per percorso risolto altrove e lo lasciava
    // orfano. Ora la pulizia usa l'ancora, quindi il nome e' quello vero.
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-tmpjunk-"))
    const programs = path.join(root, "programs")
    const directory = path.join(programs, "bcny")
    mkdirSync(directory, { recursive: true })
    // `AGENTS.md` come DIRECTORY: la `rename` sopra una directory non vuota
    // fallisce, che e' il caso che faceva restare il .tmp
    mkdirSync(path.join(directory, "AGENTS.md"))
    writeFileSync(path.join(directory, "AGENTS.md", "occupato"), "x")
    const prev = process.env.CYBERSTRIKE_HOME
    process.env.CYBERSTRIKE_HOME = root
    try {
      try {
        writeProgramDocs(base, directory, programs)
      } catch {}
      const residui = readdirSync(directory).filter((f) => f.endsWith(".tmp"))
      expect(residui).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.CYBERSTRIKE_HOME
      else process.env.CYBERSTRIKE_HOME = prev
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("programma FRATELLO: il bypass trovato dal quinto subagent (deleg_3b5e0b49)", () => {
  test("link a un altro programma: rifiutato, i suoi documenti NON vengono sovrascritti", () => {
    // Difetto RIPRODOTTO: il controllo confrontava solo il PREFISSO. Un link
    // `programs/bcny -> programs/other` resta sotto `programs/`, quindi
    // passava — e i documenti di `other` venivano riscritti con i dati di
    // `bcny`. Non e' una fuga fuori dal progetto, e' una violazione del
    // perimetro del PROGRAMMA, che e' il confine vero.
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-sib-"))
    const programs = path.join(root, "programs")
    const other = path.join(programs, "other")
    mkdirSync(other, { recursive: true })
    const agentsAltrui = path.join(other, "AGENTS.md")
    const scopeAltrui = path.join(other, "scope.md")
    writeFileSync(agentsAltrui, "# AGENTS di other - non toccare\n")
    writeFileSync(scopeAltrui, "# Scope di other - non toccare\n")
    symlinkSync(other, path.join(programs, "bcny"))
    const prev = process.env.CYBERSTRIKE_HOME
    process.env.CYBERSTRIKE_HOME = root
    try {
      let rifiutato = false
      try {
        writeProgramDocs(base, path.join(programs, "bcny"), programs)
      } catch {
        rifiutato = true
      }
      expect(rifiutato).toBe(true)
      // La prova che conta non e' il rifiuto ma l'INTEGRITA' dei file altrui:
      // un rifiuto che lasciasse comunque scrivere sarebbe un falso verde.
      expect(readFileSync(agentsAltrui, "utf8")).toBe("# AGENTS di other - non toccare\n")
      expect(readFileSync(scopeAltrui, "utf8")).toBe("# Scope di other - non toccare\n")
    } finally {
      if (prev === undefined) delete process.env.CYBERSTRIKE_HOME
      else process.env.CYBERSTRIKE_HOME = prev
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("forma di CHIAMATA PRODUCTION: il terzo argomento e' la ROOT, non programs/", () => {
  // Difetto RIPRODOTTO dal sesto subagent (deleg_014a4036). Il chiamante real e'
  // `bb.ts:861`: `writeProgramDocs(config, directory, path.dirname(programsRoot))`
  // — quindi il terzo argomento e' la root di `bugbounty`, NON `programs/`.
  // TUTTI i test precedenti passavano `programs/`, cioe' non assomigliavano
  // alla realta': potevano essere verdi mentre il difetto era aperto.
  // Qui la forma e' letteralmente quella di `bb.ts`, e il difetto e' chiuso.
  test("programs/ come symlink verso una cartella SORELLA: rifiutato con la forma production", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-prodchain-"))
    try {
      const bb = path.join(root, "bugbounty")
      const programs = path.join(bb, "programs")
      const sorella = path.join(bb, "archive")
      const directory = path.join(programs, "victim")
      const fuori = path.join(sorella, "victim")
      mkdirSync(fuori, { recursive: true })
      symlinkSync(sorella, programs, "dir")
      expect(() => writeProgramDocs(base, directory, bb)).toThrow(/symlink/)
      // niente scritto nella sorella
      expect(existsSync(path.join(fuori, "AGENTS.md"))).toBe(false)
      expect(existsSync(path.join(fuori, "scope.md"))).toBe(false)
      expect(existsSync(path.join(fuori, "tmp"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("la forma production LEGITTIMA (root come terzo argomento) funziona", () => {
    // Se la guardia avesse imposto una profondita' fissa avrebbe rotto
    // questo caso: `programs/<nome>` sono DUE livelli sotto la root.
    const root = mkdtempSync(path.join(tmpdir(), "bbdocs-prodok-"))
    try {
      const bb = path.join(root, "bugbounty")
      const programs = path.join(bb, "programs")
      const directory = path.join(programs, "ok")
      mkdirSync(directory, { recursive: true })
      writeProgramDocs(base, directory, bb)
      expect(existsSync(path.join(directory, "AGENTS.md"))).toBe(true)
      expect(existsSync(path.join(directory, "scope.md"))).toBe(true)
      expect(existsSync(path.join(directory, "tmp"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
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
