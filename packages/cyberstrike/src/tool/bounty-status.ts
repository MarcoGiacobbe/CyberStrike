import z from "zod"
import { Tool } from "./tool"
import { BountyState } from "../session/bounty-state"
import { Instance } from "../project/instance"

type Meta = {
  hunting: boolean
  directory: string
  program?: string
  phase?: string
  targets?: number
  findings?: { total: number; new: number; approved: number; duplicate: number; other: number }
  refreshed?: boolean
  divergences?: number
}

export const BountyStatusTool = Tool.define<z.ZodObject<{ refresh: z.ZodOptional<z.ZodBoolean> }>, Meta>(
  "bounty_status",
  {
  description:
    "Load (or reload) the current bug-bounty project state: phase, targets already touched, findings count. " +
    "READ THIS BEFORE PLANNING — on a bounty project, todowrite is blocked until this has been called in " +
    "this session, so you do not repeat work an earlier session already did. The target and finding figures " +
    "are DERIVED from recorded evidence, never hand-written: if you believe they are wrong, record evidence " +
    "(record_coverage_note / report_vulnerability) rather than editing the state. refresh: false shows the " +
    "state as stored, but it is still checked against the evidence and any disagreement is reported.",
  parameters: z.object({
    refresh: z.boolean().optional().describe("Re-derive targets and findings from current evidence (default true)."),
  }),
  async execute(params, ctx) {
    const dir = Instance.directory

    if (!BountyState.isHuntingDir(dir)) {
      // Fuori dai progetti di hunting non c'e' stato da caricare: il gate di
      // todowrite non si applica. QUI NON SI MARCA "caricato": se in questa
      // directory nascesse poi uno `state.json` (scritto dal tool `write`, che
      // non passa da nessun gate, o a mano), il gate risulterebbe gia' sbloccato
      // senza che lo stato sia mai stato letto. Il flag afferma "ho letto", quindi
      // non si mette se non si e' letto niente.
      return {
        title: "not a bounty project",
        output:
          `This directory is not a bug-bounty project (no state.json and not a program directory under bugbounty/programs/):\n  ${dir}\n` +
          `There is no project state to load. If this IS a bounty project, it has no state yet: ` +
          `create it before planning.`,
        metadata: { hunting: false, directory: dir } as Meta,
      }
    }

    // Stato invalido: NON si sblocca e NON si inventa. La sessione resta
    // bloccata finche' lo stato non e' leggibile — altrimenti l'agente
    // pianificherebbe senza aver visto un solo fatto. L'errore esce dal tool
    // (il gate resta chiuso: `markLoaded` non e' stato chiamato).
    const info = params.refresh === false ? readChecked(dir, ctx) : BountyState.load(ctx.sessionID, dir)

    // Le divergenze sono l'unico rilevatore di uno stato che mente: vanno
    // MOSTRATE, non calcolate e buttate. Con `refresh: false` lo stato non e'
    // ri-derivato, quindi il confronto va fatto comunque qui: mostrare cifre
    // non verificate senza dirlo sarebbe presentare una dichiarazione come
    // fatto.
    const derived = BountyState.derive(dir)
    const divergences = BountyState.divergences(info, derived)

    const lines = [
      `Program: ${field(info.program)}`,
      `Phase:   ${info.phase} (set ${field(info.phaseUpdatedAt)})`,
      ...(info.objective ? [`Objective: ${field(info.objective)}`] : []),
      "",
      `Targets touched: ${info.targets.length}`,
      ...info.targets.map((t) => `  - ${field(t.host)}  (last ${field(t.lastSeen)})`),
      "",
      `Findings: ${info.findings.total} total — ${info.findings.new} new, ${info.findings.approved} approved, ` +
        `${info.findings.duplicate} duplicate, ${info.findings.other} other`,
      ...(params.refresh === false ? ["", "(state as stored — not re-derived)"] : []),
      ...(divergences.length > 0
        ? [
            "",
            `⚠ State disagrees with recorded evidence in ${divergences.length} point(s):`,
            ...divergences.map((d) => `  - ${field(d)}`),
            `Do not trust the figures above where they disagree: record evidence ` +
              `(record_coverage_note / report_vulnerability), or re-run with refresh: true.`,
          ]
        : []),
    ]

    return {
      title: `bounty state — ${field(info.program)} (${info.phase})`,
      output: lines.join("\n"),
      metadata: {
        hunting: true,
        directory: dir,
        program: info.program,
        phase: info.phase,
        targets: info.targets.length,
        findings: info.findings,
        refreshed: params.refresh ?? true,
        divergences: divergences.length,
      },
    }
  },
  },
)

/**
 * Sanificazione all'EMISSIONE, non campo per campo.
 *
 * `program`, `objective`, `phaseUpdatedAt` e `targets[].lastSeen` sono campi
 * DICHIARATI (li scrive l'utente o li porta il nome della directory), e vengono
 * stampati riga per riga: un newline in uno di essi produce righe che sembrano
 * output del sistema ("Targets touched: 9", "Findings: 137 approved (verified)")
 * — anche con `refresh: true`, cioè nel percorso che dovrebbe essere sicuro, e
 * anche senza scrivere nessun file (basta il nome della directory).
 *
 * Sanificare campo per campo significa che ogni campo nuovo riapre il buco; qui
 * la regola è una sola e vale per qualunque stringa che finisce nell'output.
 */
function field(s: string): string {
  // `\s` copre anche i separatori Unicode (U+2028/U+2029) e i controlli che
  // `hostOf` già scarta: quello che non è una riga non deve diventare una riga.
  return s.replace(/\s+/g, " ").trim()
}

/**
 * Lettura senza ri-derivazione (`refresh: false`). Lo stato invalido propaga
 * `Unreadable` e la sessione NON viene segnata come caricata: il gate resta
 * chiuso. E' il fix del buco per cui `markLoaded` veniva eseguito prima della
 * lettura, sbloccando la sessione su un caricamento fallito.
 */
function readChecked(dir: string, ctx: { sessionID: string }) {
  const info = BountyState.read(dir) // lancia -> nessun markLoaded
  BountyState.markLoaded(ctx.sessionID)
  return info
}