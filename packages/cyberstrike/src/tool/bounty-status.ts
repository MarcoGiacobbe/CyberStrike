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
}

export const BountyStatusTool = Tool.define("bounty_status", {
  description:
    "Load (or reload) the current bug-bounty project state: phase, targets already touched, findings count. " +
    "READ THIS BEFORE PLANNING — on a bounty project, todowrite is blocked until this has been called in " +
    "this session, so you do not repeat work an earlier session already did. The target and finding figures " +
    "are DERIVED from recorded evidence, never hand-written: if you believe they are wrong, record evidence " +
    "(record_coverage_note / report_vulnerability) rather than editing the state. refresh: false shows the " +
    "state as stored without re-deriving.",
  parameters: z.object({
    refresh: z.boolean().optional().describe("Re-derive targets and findings from current evidence (default true)."),
  }),
  async execute(params, ctx) {
    const dir = Instance.directory

    if (!BountyState.isHuntingDir(dir)) {
      BountyState.markLoaded(ctx.sessionID)
      return {
        title: "not a bounty project",
        output:
          `This directory is not a bug-bounty project (no state.json and not under bugbounty/programs/):\n  ${dir}\n` +
          `There is no project state to load, and planning is not blocked.`,
        metadata: { hunting: false, directory: dir } as Meta,
      }
    }

    const doRefresh = params.refresh ?? true
    const info = doRefresh
      ? BountyState.load(ctx.sessionID, dir)
      : (BountyState.markLoaded(ctx.sessionID), BountyState.read(dir))

    const lines = [
      `Program: ${info.program}`,
      `Phase:   ${info.phase} (set ${info.phaseUpdatedAt})`,
      ...(info.objective ? [`Objective: ${info.objective}`] : []),
      "",
      `Targets touched: ${info.targets.length}`,
      ...info.targets.map((t) => `  - ${t.host}  (last ${t.lastSeen})`),
      "",
      `Findings: ${info.findings.total} total — ${info.findings.new} new, ${info.findings.approved} approved, ` +
        `${info.findings.duplicate} duplicate, ${info.findings.other} other`,
      ...(doRefresh ? [] : ["", "(state as stored — not re-derived)"]),
    ]

    return {
      title: `bounty state — ${info.program} (${info.phase})`,
      output: lines.join("\n"),
      metadata: {
        hunting: true,
        directory: dir,
        program: info.program,
        phase: info.phase,
        targets: info.targets.length,
        findings: info.findings,
        refreshed: doRefresh,
      } as Meta,
    }
  },
})
