// Bug Bounty CLI Command
// Manage bug bounty programs, load scope, and launch crawls with program config.
//
// Usage:
//   cyberstrike bb list
//   cyberstrike bb info google
//   cyberstrike bb add google --url https://www.hackerone.com/google
//   cyberstrike bb crawl google --target https://accounts.google.com

import { cmd } from "./cmd"
import {
  getBugBountyManager,
  loadHunterCredentials,
  saveHunterCredentials,
  type BountyProgramConfig,
} from "@cyberstrike-io/hackbrowser/bugbounty"
import {
  h1Alias,
  generatePassword,
  policyFromConstraints,
  loadAccounts,
  saveAccount,
} from "@cyberstrike-io/hackbrowser/bbmail"
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
        "connect",
        "save your HackerOne identity (username + optional API credentials)",
        (y) =>
          y
            .option("username", {
              type: "string",
              describe: "your HackerOne username (used to disclose automated traffic per program rules)",
            })
            .option("api-identifier", {
              type: "string",
              describe: "HackerOne API token identifier (for future bb sync; optional)",
            })
            .option("api-token", {
              type: "string",
              describe: "HackerOne API token (for future bb sync; optional)",
            }),
        async (args) => {
          const creds = loadHunterCredentials() ?? {}
          if (args.username) creds.h1_username = args.username
          if (args["api-identifier"]) creds.api_identifier = args["api-identifier"]
          if (args["api-token"]) creds.api_token = args["api-token"]
          saveHunterCredentials(creds)
          console.log(`\n✅ Hunter identity saved to ~/.cyberstrike/bugbounty/credentials.json (chmod 600)`)
          console.log(`   Username: ${creds.h1_username ?? "(not set)"}`)
          console.log(`   API token: ${creds.api_token ? "(set)" : "(not set)"}`)
          console.log(`\n💡 New programs added with 'bb add' will default to this identity.`)
        },
      )
      .command(
        "mail <action> <program>",
        "registration emails: generate alias + compliant password (step 2 = human reads the code from their inbox)",
        (y) =>
          y
            .positional("action", {
              type: "string",
              demandOption: true,
              choices: ["new", "list"],
              describe: "new = generate alias+password and store it; list = show stored accounts",
            })
            .positional("program", { type: "string", demandOption: true })
            .option("base-email", {
              type: "string",
              describe: "your real mailbox, e.g. you@gmail.com (saved globally on first use)",
            })
            .option("min-length", { type: "number", describe: "site password minimum length" })
            .option("max-length", { type: "number", describe: "site password maximum length" })
            .option("target", {
              type: "string",
              describe: "optional note: which target/app this account is for",
            }),
        async (args) => {
          if (args.action === "list") {
            const accounts = loadAccounts(args.program)
            if (accounts.length === 0) {
              console.log(`\nNo accounts stored for '${args.program}'. Create one with: bb mail new ${args.program}`)
              return
            }
            console.log(`\n📨 Accounts for ${args.program}:`)
            for (const a of accounts) {
              console.log(`   • ${a.email}  ${a.verified ? "✅ verified" : "(unverified)"}${a.target ? `  [${a.target}]` : ""}`)
            }
            return
          }

          // action === "new"
          let emailBase = args["base-email"]
          if (!emailBase) {
            // Global base saved on first use: ~/.cyberstrike/bugbounty/credentials.json .base_email
            const saved = loadHunterCredentials()?.base_email
            if (!saved) {
              UI.error("No base email known. Pass --base-email you@gmail.com once — it is saved for future runs.")
              process.exit(1)
            }
            emailBase = saved
          }
          const credsFile = loadHunterCredentials()
          if (args["base-email"] && credsFile && credsFile.base_email !== emailBase) {
            saveHunterCredentials({ ...credsFile, base_email: emailBase })
          }
          const username = credsFile?.h1_username
          if (!username) {
            UI.error("No HackerOne username configured. Run: cyberstrike bb connect --username <your-h1-username>")
            process.exit(1)
          }

          const email = h1Alias({ base: emailBase!, username, program: args.program })
          const policy = policyFromConstraints(
            [args["min-length"] && `minlength:${args["min-length"]}`, args["max-length"] && `maxlength:${args["max-length"]}`]
              .filter(Boolean)
              .join(" "),
          )
          const password = generatePassword(policy)
          saveAccount(args.program, { email, password, target: args.target, createdAt: new Date().toISOString() })

          console.log(`\n📧 Registration credentials for ${args.program}:`)
          console.log(`   Email:    ${email}`)
          console.log(`   Password: ${password}`)
          console.log(`\n📋 Step 2 (human): sign up on the target with the email above.`)
          console.log(`   Verification mail lands in YOUR inbox (${emailBase}) — read the`)
          console.log(`   code/link there and complete it; the agent asks you when needed.`)
          console.log(`\n💾 Stored in ~/.cyberstrike/bugbounty/${args.program}.accounts.json (chmod 600)`)
        },
      )
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
            .option("description", { type: "string", describe: "program description" })
            .option("h1-username", {
              type: "string",
              describe: "username to disclose in this program's traffic (defaults to bb connect identity)",
            })
            .option("header-name", {
              type: "string",
              describe: 'custom header the program requires, e.g. "X-Hunter-Id" (empty = none)',
            })
            .option("ua-template", {
              type: "string",
              describe: 'User-Agent template with {username}, e.g. "my-bot/1.0 (+H1:{username})"',
            }),
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

          // Identity: explicit flags win, otherwise default from bb connect.
          // The identity is configured at ADD time, taken from what the
          // program's policy asks for, and applied from the first request.
          const global = loadHunterCredentials()
          const username = args["h1-username"] ?? global?.h1_username
          if (username) {
            config.identity = {
              h1_username: username,
              ...(args["header-name"] ? { header_name: args["header-name"] } : {}),
              ...(args["ua-template"] ? { user_agent_template: args["ua-template"] } : {}),
            }
          }

          bb.addProgram(args.program, config)
          console.log(`\n✅ Added bug bounty program: ${args.program}`)
          console.log(`   Config saved to ~/.cyberstrike/bugbounty/${args.program}.json`)
          if (config.identity) {
            console.log(`   Identity: H1:${config.identity.h1_username}${config.identity.header_name ? ` + header ${config.identity.header_name}` : ""}`)
          } else {
            console.log(`   Identity: none (set with 'bb connect' or 'bb add --h1-username')`)
          }
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