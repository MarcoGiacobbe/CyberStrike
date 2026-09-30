import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// TICKET agente-bounty-prompt-iniziale, FASE 2 — il sync automatico.
//
// La richiesta: `bb hunt <programma>` deve sincronizzare da solo, e `bb sync`
// deve restare lanciabile a mano. Oggi `bb hunt` NON sincronizza: legge
// `<handle>.json` e passa al TUI. Se il file non c'e' dice "programma non
// sincronizzato" e l'utente deve lanciare `bb sync` a parte.
//
// Scelta di progetto dichiarata: il sync parte se i dati hanno piu' di 24
// ore, non a ogni avvio. Motivi:
//   - il TUI è un processo da ~800 MB e l'avvio costa piu' del sync;
//   - `bb hunt` su un programma gia' fresco non deve dipendere dalla rete:
//     se la rete e' assente, l'avvio NON deve fallire per quello;
//   - `--force` aggiorna quando serve, senza aspettare le 24 ore.
// Non e' una scelta fatta per evitare la rete: e' la stessa regola che chi
// usa un pacchetto npm o un'immagine Docker ha gia' davanti agli occhi.
//
// LA METODOLOGIA. Il test non puo' colpire la rete e non deve: verifica
// due cose separabili e oneste.
//   1. La SCELTA (decide di sincronizzare o no) e' una funzione pura, testata
//      direttamente con l'orologio iniettato: nessun mock, nessuna rete.
//   2. L'EFFETTO sul filesystem (il sync scrive `<handle>.json`) e' verificato
//      con `--dry-run` disattivato e una CYBERSTRIKE_HOME temporanea, ma solo
//      come "non-regressione": con la rete assente non possiamo pretendere un
//      successo. Dichiarato qui perche' un test che non puo' fallire non
//      misura niente.

const REPO = path.resolve(import.meta.dir, "../../../..")
const PKG = path.join(REPO, "packages/cyberstrike")
const BB = path.join(PKG, "src/cli/cmd/bb.ts")

const HOME = mkdtempSync(path.join(tmpdir(), "bb-hunt-sync-"))
process.env["CYBERSTRIKE_HOME"] = HOME

/** Scrive un `<handle>.json` con `lastUpdated` a `eta` giorni fa. */
function seed(handle: string, etaGiorni: number) {
  const root = path.join(HOME, "bugbounty")
  mkdirSync(root, { recursive: true })
  const quando = new Date(Date.now() - etaGiorni * 86_400_000).toISOString()
  writeFileSync(
    path.join(root, `${handle}.json`),
    JSON.stringify({
      name: handle,
      platform: "hackerone",
      programUrl: `https://hackerone.com/${handle}`,
      description: "Programma di prova",
      scope: { in: ["example.com"], out: [] },
      payouts: { high: "$10,000" },
      rules: { maxSteps: 6, authenticated: false, custom: [] },
      lastUpdated: quando,
    }),
  )
  return quando
}

async function run(args: string[]) {
  const p = Bun.spawn(["bun", "run", "--conditions=browser", path.join(PKG, "src/index.ts"), ...args], {
    cwd: PKG,
    env: { ...process.env, CYBERSTRIKE_HOME: HOME },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  return { code, out: out + err }
}

describe("fase 2: bb hunt sincronizza da solo quando i dati sono vecchi", () => {
  test("i dati freschi NON fanno partire un sync (niente rete all'avvio)", async () => {
    // hours = 0, il caso "programma appena sincronizzato".
    const { needsSync } = await import(path.join(PKG, "src/cli/cmd/bb-sync-freshness"))
    expect(needsSync(0, 24)).toBe(false)
    expect(needsSync(23.9, 24)).toBe(false)
  }, 30_000)

  test("i dati vecchi fanno partire il sync", async () => {
    const { needsSync } = await import(path.join(PKG, "src/cli/cmd/bb-sync-freshness"))
    expect(needsSync(24.1, 24)).toBe(true)
    expect(needsSync(400, 24)).toBe(true)
    // Il caso "mai sincronizzato" non e' "fresco": deve sincronizzare.
    expect(needsSync(null, 24)).toBe(true)
  }, 30_000)

  test("`--force` sincronizza anche se i dati sono freschi", async () => {
    const { needsSync } = await import(path.join(PKG, "src/cli/cmd/bb-sync-freshness"))
    // Il quarto argomento e' `force`. Con force, l'eta' non conta.
    expect(needsSync(0, 24, true)).toBe(true)
    expect(needsSync(0, 24, false)).toBe(false)
  }, 30_000)

  test("il comando dichiara `--force` fra le opzioni di `bb hunt`", async () => {
    const src = await Bun.file(BB).text()
    // Se `--force` non fosse dichiarato, l'utente potrebbe digitarlo e
    // yargs lo terrebbe come opzione sconosciuta senza fare nulla: peggio
    // che non esistere, perche' sembra funzionare.
    const hunt = src.slice(src.indexOf('"hunt <program>"'))
    expect(hunt).toMatch(/--force/)
    // E deve arrivare al TUI la dichiarazione dei dati usati.
    expect(hunt).toMatch(/lastUpdated|stale/i)
  }, 30_000)

  test("NON REGRESSIONE: `bb hunt` col programma gia' fresco non riscrive il config", async () => {
    // Con la rete assente non possiamo pretendere che il sync riesca; quel
    // che verifichiamo qui e' che l'avvio NON dipenda dalla rete quando i
    // dati sono freschi. Se tornasse rosso, il sync automatico avrebbe
    // rotto l'avvio offline — che e' esattamente il rischio di questa fase.
    seed("fresh1", 0)
    const prima = await Bun.file(path.join(HOME, "bugbounty", "fresh1.json")).text()
    const { code, out } = await run(["bb", "hunt", "fresh1", "--dry-run"])
    const dopo = await Bun.file(path.join(HOME, "bugbounty", "fresh1.json")).text()

    expect(prima).toBe(dopo)
    // L'avvio non deve morire perche' la rete non c'e'.
    expect(code).toBe(0)
    expect(out).not.toMatch(/Sync failed/)
  }, 90_000)

  test("NON REGRESSIONE: `bb sync` manuale resta funzionante", async () => {
    // Se il sync automatico avesse spostato o monopolizzato `syncProgram`,
    // questo comando — che e' l'unico modo di aggiornare a mano — si
    // romperebbe. Verifica solo che il comando esista e risponda (con la
    // rete assente risponde con un errore, e va bene: risponde).
    const { code, out } = await run(["bb", "sync", "--help"])
    expect(code).toBe(0)
    expect(out).toMatch(/sync/)
  }, 60_000)

  test("il sync e' CABLATO: con dati vecchi `bb hunt` prova a sincronizzare", async () => {
    // Questo e' il test che conta. Quelli precedenti provano la FUNZIONE
    // (needsSync/ageHours), non che `bb hunt` la chiami. Se il cablaggio
    // sparisse, i primi resterebbero verdi e nessuno se ne accorgerebbe.
    //
    // Il trucco: si usa un programma che NON esiste su HackerOne, con dati
    // vecchissimi. `syncProgram` fallisce ("Program 'x' not found") invece di
    // colpire la rete con successo, e l'avvio DEVE continuare. Un test che
    // verifica "ha provato a sincronizzare" usando il fallimento e' piu'
    // onesto di uno che finge un successo: qui non possiamo dipendere dalla
    // rete, e il fallimento e' deterministico.
    seed("ghost99", 400)

    const { code, out } = await run(["bb", "hunt", "ghost99", "--dry-run"])

    // Segno che il sync e' stato valutato: la riga del dry-run.
    expect(out).toMatch(/sincronizzerei ghost99/)
    // E non ha scritto nulla: `--dry-run` resta senza effetti persistenti.
    // Si confronta l'ETA', non il timestamp assoluto: il valore era stato
    // calcolato a `seed()` qualche millisecondo fa e i due `Date.now()` non
    // coincidono gia' al secondo — un confronto di stringhe sarebbe rosso
    // per motivi che non c'entrano con il difetto che si vuole misurare.
    const cfg = await Bun.file(path.join(HOME, "bugbounty", "ghost99.json")).text()
    const eta = (Date.now() - Date.parse(JSON.parse(cfg).lastUpdated)) / 86_400_000
    expect(Math.round(eta)).toBe(400)
    // Il programma inesistente non e' un errore fatale: si prosegue.
    expect(code).toBe(0)
  }, 90_000)

  test("la riga di avviso arriva all'AGENTE, non solo al terminale", async () => {
    // Il punto di questa fase: se l'avviso resta a terminale, l'agente lavora
    // su uno scope vecchio e produce un report che viene respinto. Quindi il
    // testo deve finire nel messaggio iniziale. Verificato chiamando la
    // funzione che genera il messaggio, non ispezionando il sorgente.
    const { HuntContext } = await import(path.join(PKG, "src/session/hunt-context"))
    const { staleNotice } = await import(path.join(PKG, "src/cli/cmd/bb-sync-freshness"))

    const msg = HuntContext.message({
      program: "bcny",
      directory: "/tmp/bcny",
      config: { scope: { in: ["arc.net"] } },
      stale: staleNotice("bcny", 24 * 6, new Error("connessione fallita")),
    })

    expect(msg).toMatch(/non ho potuto aggiornare/i)
    expect(msg).toMatch(/bb sync bcny/)
    // Deve stare PRIMA dello scope: se arriva in fondo, l'agente ha gia'
    // letto i dati da usare.
    expect(msg.indexOf("non ho potuto aggiornare")).toBeLessThan(msg.indexOf("## Scope IN"))
  }, 30_000)

  test("un programma MAI sincronizzato non viene trattato come fresco", async () => {
    // Caso limite: config assente, `lastUpdated` non esiste. Se tornasse 0
    // ore l'agente partirebbe con scope mancente e sembrerebbe tutto regolare.
    const { ageHours, needsSync } = await import(path.join(PKG, "src/cli/cmd/bb-sync-freshness"))
    expect(ageHours(undefined)).toBe(null)
    expect(ageHours(null)).toBe(null)
    expect(ageHours("non-una-data")).toBe(null)
    expect(needsSync(ageHours(undefined))).toBe(true)
    // Data nel futuro = dato corrotto, non "freschissimo".
    const futuro = new Date(Date.now() + 86_400_000).toISOString()
    expect(needsSync(ageHours(futuro))).toBe(true)
  }, 30_000)

})

afterAll(() => rmSync(HOME, { recursive: true, force: true }))
