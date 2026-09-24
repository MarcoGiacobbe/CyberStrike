// Bug Bounty CLI Command
// Manage bug bounty programs, load scope, and launch crawls with program config.
//
// Usage:
//   cyberstrike bb list
//   cyberstrike bb info google
//   cyberstrike bb add google --url https://www.hackerone.com/google
//   cyberstrike bb crawl google --target https://accounts.google.com

import { cmd } from "./cmd"
import { getBugBountyManager, type BountyProgramConfig } from "@cyberstrike-io/hackbrowser/bugbounty"
import { UI } from "../ui"
import { spawn } from "node:child_process"

function printProgramInfo(config: BountyProgramConfig) {
  console.log(`\n🎯 Bug Bounty Program: ${config.name}`)
  console.log(`   Platform: ${config.platform || "custom"}`)
  if (config.programUrl) console.log(`   URL: ${config.programUrl}`)
  if (config.description) console.log(`   ${config.description}`)

  console.log("\n📍 Scope (in):")
  for (const target of config.scope.in) {
    console.log(`   • ${target}`)
  }

  if (config.scope.out.length > 0) {
    console.log("\n🚫 Out of scope:")
    for (const target of config.scope.out) {
      console.log(`   • ${target}`)
    }
  }

  if (config.payouts) {
    console.log("\n💰 Payouts:")
    console.log(`   Low: ${config.payouts.low}`)
    console.log(`   Medium: ${config.payouts.medium}`)
    console.log(`   High: ${config.payouts.high}`)
    console.log(`   Critical: ${config.payouts.critical}`)
  }

  if (config.knownIssues && config.knownIssues.length > 0) {
    console.log(`\n⚠️  Known issues: ${config.knownIssues.length}`)
    for (const issue of config.knownIssues.slice(0, 5)) {
      console.log(`   • [${issue.status}] ${issue.title}`)
    }
    if (config.knownIssues.length > 5) {
      console.log(`   ... and ${config.knownIssues.length - 5} more`)
    }
  }

  if (config.rules) {
    console.log("\n📜 Rules:")
    if (config.rules.maxSteps) console.log(`   Max steps: ${config.rules.maxSteps}`)
    if (config.rules.authenticated) console.log(`   Requires auth: true`)
  }
}

export const BBCommand = cmd({
  command: "bb <action>",
  describe: "manage bug bounty programs",
  builder: (yargs) =>
    yargs
      .command(
        "list",
        "list all bug bounty programs",
        () => {},
        async () => {
          const bb = getBugBountyManager()
          const programs = bb.listPrograms()

          if (programs.length === 0) {
            console.log("\nNo bug bounty programs configured.")
            console.log("Add one with: cyberstrike bb add <name> --url <program-url>")
            return
          }

          console.log("\n🎯 Bug Bounty Programs:")
          for (const name of programs) {
            console.log(`   • ${name}`)
          }
        },
      )
      .command(
        "info <program>",
        "show program details",
        (y) => y.positional("program", { type: "string", demandOption: true }),
        async (args) => {
          const bb = getBugBountyManager()
          try {
            bb.loadProgram(args.program)
            const config = bb.getProgramConfig()
            if (config) {
              printProgramInfo(config)
            }
          } catch (err) {
            UI.error(`Failed to load program '${args.program}': ${err}`)
            process.exit(1)
          }
        },
      )
      .command(
        "add <program>",
        "add a bug bounty program",
        (y) =>
          y
            .positional("program", { type: "string", demandOption: true, describe: "program name" })
            .option("url", {
              type: "string",
              demandOption: true,
              describe: "bug bounty program URL (HackerOne, Bugcrowd, etc.)",
            })
            .option("platform", {
              type: "string",
              default: "hackerone",
              choices: ["hackerone", "bugcrowd", "intigriti", "custom"],
              describe: "bug bounty platform",
            })
            .option("description", { type: "string", describe: "program description" }),
        async (args) => {
          const bb = getBugBountyManager()

          // TODO: Actually scrape the bug bounty program URL for scope/payouts/rules
          // For now, create a basic config that user can edit
          const config: BountyProgramConfig = {
            name: args.program,
            platform: args.platform as BountyProgramConfig["platform"],
            programUrl: args.url,
            description: args.description,
            scope: {
              in: [],
              out: [],
            },
            payouts: {
              low: "$100",
              medium: "$500",
              high: "$1000",
              critical: "$5000",
            },
            rules: {
              maxSteps: 100,
              authenticated: true,
            },
            knownIssues: [],
            lastUpdated: new Date().toISOString(),
          }

          bb.addProgram(args.program, config)
          console.log(`\n✅ Added bug bounty program: ${args.program}`)
          console.log(`   Config saved to ~/.cyberstrike/bugbounty/${args.program}.json`)
          console.log("\n💡 Edit the config file to set scope, payouts, and rules:")
          console.log(`   $ nano ~/.cyberstrike/bugbounty/${args.program}.json`)
        },
      )
      .command(
        "remove <program>",
        "remove a bug bounty program",
        (y) => y.positional("program", { type: "string", demandOption: true }),
        async (args) => {
          const bb = getBugBountyManager()
          try {
            bb.removeProgram(args.program)
            console.log(`\n✅ Removed bug bounty program: ${args.program}`)
          } catch (err) {
            UI.error(`Failed to remove program '${args.program}': ${err}`)
            process.exit(1)
          }
        },
      )
      .command(
        "crawl <program>",
        "crawl a bug bounty program target",
        (y) =>
          y
            .positional("program", { type: "string", demandOption: true })
            .option("target", {
              type: "string",
              describe: "target URL (defaults to first in-scope target)",
            })
            .option("steps", { type: "number", describe: "max crawl steps" })
            .option("credential", {
              type: "string",
              array: true,
              describe: "credential label for authentication",
            })
            .option("headfull", { type: "boolean", default: false }),
        async (args) => {
          // Load program config and launch hackbrowser with it
          const bb = getBugBountyManager()
          let config: any
          try {
            bb.loadProgram(args.program)
            config = bb.getProgramConfig()
          } catch (err) {
            UI.error(`Failed to load program '${args.program}': ${err}`)
            process.exit(1)
          }

          if (!config) {
            UI.error(`Program config not found: ${args.program}`)
            process.exit(1)
          }

          const target = args.target || config.scope.in[0]
          if (!target) {
            UI.error("No target specified and no in-scope targets in program config")
            process.exit(1)
          }

          console.log(`\n🚀 Crawling ${args.program}: ${target}`)
          console.log("   (Bug Bounty mode — scope from program config)")

          // Build hackbrowser args
          const hackArgs = [`hackbrowser`, target, `--bugbounty-program`, args.program]

          if (args.steps) hackArgs.push("--steps", String(args.steps))
          if (args.credential) {
            for (const cred of args.credential) {
              hackArgs.push("--credential", cred)
            }
          }
          if (args.headfull) hackArgs.push("--headfull")

          // Spawn the cyberstrike hackbrowser subcommand in a subprocess.
          // process.argv[1] is the entry script (bun src/index.ts) or the
          // compiled binary itself — works in both dev and --compile builds.
          const child = spawn(process.argv[0]!, [process.argv[1]!, ...hackArgs], {
            stdio: "inherit",
          })

          child.on("close", (code: number | null) => {
            process.exit(code ?? 1)
          })
        },
      ),
  handler: async (args) => {},
})