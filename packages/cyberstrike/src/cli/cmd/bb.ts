// Bug Bounty CLI Command
// Manage bug bounty programs, load scope, and launch crawls with program config.
//
// Usage:
//   cyberstrike bb list
//   cyberstrike bb info google
//   cyberstrike bb add google --url https://www.hackerone.com/google
//   cyberstrike bb crawl google --target https://accounts.google.com

import { cmd } from "./cmd"
// `yargs()` serve all'handler qui sotto: senza l'azione non arriva nessun
// subcomando, e `showHelp()` su un'istanza nuova stampa l'help di `bb`.
// L'import mancante rendeva l'handler non compilabile — segnalato dal LSP.
import yargs from "yargs"
import {
  getBugBountyManager,
  loadHunterCredentials,
  saveHunterCredentials,
  credentialsFilePath,
  type BountyProgramConfig,
} from "@cyberstrike-io/hackbrowser/bugbounty"
import {
  h1Alias,
  generatePassword,
  policyFromConstraints,
  loadAccounts,
  saveAccount,
} from "@cyberstrike-io/hackbrowser/bbmail"
import {
  loadManagedAccounts,
  setAccountStatus,
} from "@cyberstrike-io/hackbrowser/accounts"
import { syncProgram } from "@cyberstrike-io/hackbrowser/sync"
import * as fresh from "./bb-sync-freshness"
import { writeProgramDocs } from "./bb-program-docs"
import * as err from "../../session/bb-errors"
import { UI } from "../ui"
import { spawn } from "node:child_process"
import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { BountyState } from "../../session/bounty-state"
import { HuntContext } from "../../session/hunt-context"
import { ProjectPerimeter } from "../../permission/project"
import { Session } from "../../session"
import { bootstrap } from "../bootstrap"

/**
 * Validate HackerOne API credentials against a read-only endpoint.
 *
 * The endpoint is /v1/hackers/programs (the programs the token can see), not
 * /v1/me: HackerOne documents /v1/me but it answers 401 for personal hacker
 * tokens (verified — only org/admin tokens resolve there). It is still the
 * cheapest honest check: 200 proves the credential pair works.
 *
 * `username` is the H1 username from step 1. Personal tokens use it AS the
 * identifier, so when the given identifier is rejected we retry once with the
 * username — the historically most common cause of a bogus 401 is pasting the
 * token value into the identifier field.
 */
async function validateH1Api(
  identifier: string,
  token: string,
  username?: string,
): Promise<{ ok: boolean; status: number; usedIdentifier: string }> {
  const attempt = async (id: string) => {
    const res = await fetch("https://api.hackerone.com/v1/hackers/programs?page%5Bsize%5D=1", {
      headers: {
        authorization: `Basic ${Buffer.from(`${id}:${token}`).toString("base64")}`,
        accept: "application/json",
      },
    })
    return res.status
  }

  const status = await attempt(identifier)
  if (status !== 401) return { ok: true, status, usedIdentifier: identifier }

  if (username && username !== identifier) {
    const retry = await attempt(username)
    if (retry !== 401) return { ok: true, status: retry, usedIdentifier: username }
  }
  return { ok: false, status, usedIdentifier: identifier }
}

/**
 * I programmi che l'utente ha gia' in locale, per l'errore "programma
 * inesistente". Un refuso e' molto piu' probabile di un programma cancellato,
 * quindi mostrare gli handle validi e' la cosa che fa risolvere il problema
 * senza dover chiedere. `listPrograms()` esclude gia' i nomi riservati.
 */
function elencoLocale(): string {
  try {
    return getBugBountyManager().listPrograms().join(", ")
  } catch {
    // Se la lista non e' leggibile l'errore va comunque detto: il refuso
    // resta visibile nella riga principale.
    return ""
  }
}

/** Mask a secret for display: first 7 chars + ellipsis + last 3. */
function maskSecret(value: string): string {
  if (value.length <= 12) return "…"
  return `${value.slice(0, 7)}…${value.slice(-3)}`
}

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
        "interactive wizard: save your HackerOne identity (username, base email, API token)",
        (y) =>
          y
            .option("username", { type: "string", describe: "skip the prompt for username" })
            .option("base-email", { type: "string", describe: "skip the prompt for base email" })
            .option("api-identifier", {
              type: "string",
              describe: "API username, only if it differs from your H1 username (defaults to it)",
            })
            .option("api-token", { type: "string", describe: "HackerOne API token value (the secret)" })
            .option("reset", { type: "boolean", describe: "start over even if already connected" })
            .option("cancel", { type: "boolean", describe: "alias for --reset semantics cleanup" })
            .example("$0 bb connect", "run the interactive wizard"),
        async (args) => {
          const existing = loadHunterCredentials()
          const connected = !!existing && (!!existing.h1_username || !!existing.base_email || !!existing.api_token)

          // Already connected → show details, offer cancel/update, no re-entry.
          if (connected && !args.reset) {
            console.log(`\n👤 Already connected:`)
            console.log(`   Username: ${existing!.h1_username ?? "(not set)"}`)
            console.log(`   Base email: ${existing!.base_email ?? "(not set)"}`)
            console.log(
              `   API: ${existing!.api_token ? `${existing!.api_identifier ?? existing!.h1_username ?? "?"} + ${maskSecret(existing!.api_token)}` : "(not set)"}`,
            )
            console.log(`\nOptions:`)
            console.log(`   • cyberstrike bb whoami            — view details again`)
            console.log(`   • cyberstrike bb connect --reset   — start over (clears and re-asks)`)
            console.log(`   • cyberstrike bb disconnect        — remove saved identity`)
            return
          }

          console.log(`\n🔐 Bug Bounty Connect — configure your Hunter identity\n`)
          const creds: Record<string, string> = { ...(existing ?? {}) }

          // ---- Step 1: username (HITL, confirm/cancel per step) ----
          creds.h1_username =
            args.username ??
            (await UI.input(`Step 1/2 — HackerOne username (what programs see): `))
          if (creds.h1_username && !/^[a-zA-Z0-9_-]{2,40}$/.test(creds.h1_username)) {
            UI.error("Invalid username (allowed: letters, digits, _ and -; 2-40 chars).")
            process.exit(1)
          }
          console.log(`   → username: ${creds.h1_username || "(skipped)"}  [OK]  (Annulla: Ctrl+C)`)

          // ---- Step 2: base email ----
          const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
          creds.base_email =
            args["base-email"] ??
            (await UI.input(`Step 2/2 — Base email for program aliases (empty = skip): `))
          if (creds.base_email && !emailRe.test(creds.base_email)) {
            UI.error(`Invalid email: ${creds.base_email}`)
            process.exit(1)
          }
          console.log(`   → base email: ${creds.base_email || "(skipped)"}  [OK]  (Annulla: Ctrl+C)`)

          // ---- Step 3: API access ----
          //
          // On HackerOne the API is authenticated with HTTP Basic where the
          // USERNAME is the identifier and the TOKEN is the value. For a
          // personal (hacker) token the identifier IS the H1 username, so
          // asking for it again is a duplicate of step 1 — the default path
          // skips it entirely and reuses the username. Only accounts holding
          // an explicitly-named org/admin token (or a hunter who generated a
          // token with a custom identifier) need a different one, and that is
          // what --api-identifier is for.
          if (args["api-identifier"] || args["api-token"]) {
            creds.api_identifier = args["api-identifier"] ?? creds.h1_username
            creds.api_token =
              args["api-token"] ?? (await UI.input(`Step 3/3 — API token value (shown once on H1; paste now): `))
            if (!creds.api_identifier || !creds.api_token) {
              UI.error("Both identifier and token are required for API access. Nothing saved.")
              process.exit(1)
            }
            const result = await validateH1Api(creds.api_identifier, creds.api_token, creds.h1_username)
            if (!result.ok) {
              UI.error(`API credentials REJECTED (${result.status}). Nothing saved.`)
              console.log(`\n   The identifier is the API username — NOT the token value.`)
              console.log(`   For a personal token the identifier is your H1 username (${creds.h1_username ?? "?"}).`)
              process.exit(1)
            }
            if (result.usedIdentifier !== creds.api_identifier) {
              creds.api_identifier = result.usedIdentifier
              console.log(`   → identifier "${args["api-identifier"]}" rejected; using your H1 username instead`)
            }
            console.log(`   → API: ${creds.api_identifier} + token  [OK]`)
          } else {
            console.log("   → API: (no token given — sync still works for public programs)")
          }

          saveHunterCredentials(creds as never)
          console.log(`\n✅ Identity saved to ~/.cyberstrike/bugbounty/credentials.json (chmod 600)`)
          console.log(`\nNext: cyberstrike bb sync <handle>   — fetch a public program`)
          console.log(`      cyberstrike bb whoami          — view saved identity`)
        },
      )
      .command(
        "disconnect",
        "remove the saved hunter identity",
        () => {},
        async () => {
          const p = credentialsFilePath()
          const { unlinkSync, existsSync } = await import("fs")
          if (!existsSync(p)) {
            console.log("\nNothing to remove — no identity saved.")
            return
          }
          unlinkSync(p)
          console.log("\n🗑️  Identity removed (~/.cyberstrike/bugbounty/credentials.json).")
        },
      )
      .command(
        "whoami",
        "show the saved hunter identity",
        () => {},
        async () => {
          const creds = loadHunterCredentials()
          if (!creds) {
            console.log("\nNo identity saved. Run: cyberstrike bb connect --username <h1-username>")
            return
          }
          console.log(`\n👤 Hunter identity (~/.cyberstrike/bugbounty/credentials.json):`)
          console.log(`   Username: ${creds.h1_username ?? "(not set)"}`)
          console.log(`   Base email: ${creds.base_email ?? "(not set)"}`)
          // Never echo the token: mask it so a screen share / log paste cannot leak it.
          console.log(
            `   API: ${creds.api_token ? `${creds.api_identifier ?? creds.h1_username ?? "?"} + ${maskSecret(creds.api_token)}` : "(not set)"}`,
          )
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
        "sync <program>",
        "fetch live program data (scope, payouts, rules) from HackerOne — no token needed for public programs",
        (y) =>
          y.positional("program", { type: "string", demandOption: true, describe: "HackerOne handle, e.g. bcny" }),
        async (args) => {
          console.log(`\n🔄 Syncing '${args.program}' from HackerOne…`)
          try {
            const r = await syncProgram(args.program)
            console.log(`✅ ${r.name} (@${args.program})`)
            console.log(`   In scope (${r.inScope.length}): ${r.inScope.join(", ") || "—"}`)
            if (r.outScope.length) console.log(`   Out of scope (${r.outScope.length}): ${r.outScope.join(", ")}`)
            console.log(`   Bounty table rows: ${r.bountyAssets} assets | policy: ${r.rulesChars} chars`)
            console.log(`   Saved to ~/.cyberstrike/bugbounty/${args.program}.json (+ .policy.md)`)
            console.log(`\n▶ Ready: cyberstrike bb info ${args.program} | cyberstrike bb crawl ${args.program}`)
          } catch (err) {
            UI.error(`Sync failed: ${err instanceof Error ? err.message : err}`)
            process.exit(1)
          }
        },
      )
      .command(
        "accounts <action> <program>",
        "manage autonomously-created target accounts (approve after you verified the email)",
        (y) =>
          y
            .positional("action", {
              type: "string",
              demandOption: true,
              choices: ["list", "approve", "disable"],
              describe: "list = show accounts; approve/disable = set status",
            })
            .positional("program", { type: "string", demandOption: true })
            .option("email", { type: "string", describe: "account email (required for approve/disable)" }),
        async (args) => {
          if (args.action === "list") {
            const accounts = loadManagedAccounts(args.program)
            if (accounts.length === 0) {
              console.log(`\nNo managed accounts for '${args.program}' yet. They are created automatically when the crawler fills a signup form (bb connect required).`)
              return
            }
            console.log(`\n👤 Managed accounts for ${args.program}:`)
            for (const a of accounts) {
              const icon = a.status === "approved" ? "✅" : a.status === "pending" ? "⏳" : "🚫"
              console.log(`   ${icon} ${a.email}  [${a.status}]${a.target ? ` → ${a.target}` : ""}  created ${a.createdAt.slice(0, 10)}`)
            }
            console.log(`\nApprove after verifying the email: bb accounts approve ${args.program} --email <email>`)
            return
          }
          if (!args.email) {
            UI.error(`--email is required for '${args.action}'`)
            process.exit(1)
          }
          const status = args.action === "approve" ? "approved" : "disabled"
          const ok = setAccountStatus(args.program, args.email, status)
          if (!ok) {
            UI.error(`Account ${args.email} not found for program '${args.program}'`)
            process.exit(1)
          }
          console.log(`\n${status === "approved" ? "✅" : "🚫"} ${args.email} → ${status}`)
          if (status === "approved") console.log("   The crawler can now reuse this account for login flows.")
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
      )
      .command(
        "hunt <program>",
        "open a hunting session for a program: project dir + state + perimeter, then the TUI",
        (y) =>
          y
            .positional("program", { type: "string", demandOption: true })
            .option("agent", {
              type: "string",
              default: "web-application",
              describe: "agent to run the hunt with",
            })
            .option("dry-run", {
              type: "boolean",
              default: false,
              describe: "print the initial message, the perimeter and the state, then exit",
            })
            .option("force", {
              type: "boolean",
              default: false,
              describe: "sync the program even if its data is less than 24h old",
            }),
        async (args) => {
          const program = args.program

          // Il nome del programma finisce dentro un path (`directory()` fa
          // path.join). Senza questo controllo un nome come `../../../tmp`
          // portava la directory — e quindi il PERIMETRO — fuori da programs/,
          // con `allow edit` su una directory arbitraria. Misurato il
          // 2026-09-26: `bb hunt "../../../tmp"` dava perimetro su /tmp.
          // Il vincolo e' che il path RISOLTO resti dentro programs/: e' piu'
          // forte di un elenco di caratteri vietati (copre `..`, separatori,
          // nomi vuoti, e quello che non ho ancora pensato).
          const base = BountyState.root()
          const programsRoot = BountyState.programsDir()
          const directory = BountyState.directory(base, program)
          const rel = path.relative(programsRoot, directory)
          if (
            rel === "" ||
            rel === ".." ||
            rel.startsWith(".." + path.sep) ||
            path.isAbsolute(rel)
          ) {
            UI.error(
              `Nome di programma non valido: "${program}". ` +
                `Un progetto deve stare dentro ${programsRoot}.`,
            )
            process.exit(1)
          }

          // 1. Program config: può non esistere (programma mai sincronizzato) o
          //    il programma può essere stato rimosso con `bb remove`. Entrambi i
          //    casi avvisano e proseguono: il progetto esiste comunque e non
          //    bloccare qui impedirebbe di chiudere il lavoro precedente.
          // Il programma esiste SE c'e' il suo `<handle>.json` nella root bug
          // bounty. Non uso `getProgramConfig()`: quello restituisce il config
          // "caricato" in memoria, che puo' essere quello di una chiamata
          // precedente o nulla — `unsynced` non diventava mai vero e la
          // directory veniva creata anche per un programma inesistente
          // (misurato il 2026-09-26). Il filesystem non mente.
          const configPath = path.join(
            process.env.CYBERSTRIKE_HOME ?? path.join(os.homedir(), ".cyberstrike"),
            "bugbounty",
            `${program}.json`,
          )
          let config: any
          let unsynced = true
          try {
            config = JSON.parse(fs.readFileSync(configPath, "utf8"))
            unsynced = false
          } catch {
            config = undefined
          }

          // 1b. Il sync automatico. `bb hunt` ricarica i dati del programma se
          //     hanno piu' di 24 ore, cosi' l'utente non deve ricordarsi di
          //     lanciare `bb sync` prima di ogni sessione. `--force` lo forza.
          //
          //     Tre regole, tutte qui perche' il perche' si vede meglio che
          //     nei commit:
          //       - `--dry-run` NON sincronizza: un dry-run che scrive in
          //         ~/.cyberstrike non e' un dry-run.
          //       - Se il sync fallisce l'avvio CONTINUA con i dati di prima.
          //         Bloccare qui vuol dire che una rete assente impedisce di
          //         chiudere il lavoro di ieri; l'avviso dice invece all'agente
          //         che quei dati non sono freschi, ed e' lui a decidere.
          //       - Il fallback per l'agente e' `staleNotice`: l'avviso va
          //         NEL PROMPT, non solo a terminale, perche' se l'agente
          //         produce un report su uno scope vecchio il report viene
          //         respinto.
          let stale: string | undefined
          const etaPrima = fresh.ageHours(config?.lastUpdated)
          if (fresh.needsSync(etaPrima, fresh.DEFAULT_MAX_AGE_HOURS, args.force === true)) {
            if (args.dryRun) {
              console.log(
                `(--dry-run: sincronizzerei ${program} — dati di ${etaPrima === null ? "?" : Math.floor(etaPrima / 24) + " giorni" } fa)`,
              )
              // Non si puo' sapere qui se il programma esiste: `--dry-run` non
              // sincronizza, quindi nessuna richiesta parte e nessun errore
              // arriva. Dichiararlo e' l'unica cosa onesta — il comando serve
              // proprio a ispezionare, e "sincronizzerei ghost" senza
              // avvertire sarebbe l'informazione sbagliata proprio nel comando
              // da cui l'utente si aspetta di capire.
              console.log(
                `(--dry-run: il programma su HackerOne NON e' stato verificato. ` +
                  `Senza questo controllo un refuso passerebbe. Senza --dry-run si ferma.)`,
              )
            } else {
              console.log(`🔄 Aggiorno i dati di ${program}…`)
              try {
                await syncProgram(program)
                config = JSON.parse(fs.readFileSync(configPath, "utf8"))
                unsynced = false
                console.log(`✅ ${program} aggiornato`)
              } catch (e) {
                // Un programma inesistente NON e' il fallback della Fase 2.
                // "Rete assente" e "questo programma non esiste" sono due fatti
                // diversi: il primo si risolve riprovando piu' tardi, il secondo
                // non si risolve affatto. Partire con uno scope fantasma fa
                // produrre finding su target che non esistono, e l'utente lo
                // scopre solo quando il report viene respinto.
                //
                // Nota: si ferma anche se il programma ERA in locale. Avevo
                // un tempo la condizione `&& unsynced`, per non fermarmi se il
                // file c'era gia'. Era una tolleranza che non serve a niente:
                // se HackerOne non lo conferma piu', l'agente lavorerebbe su
                // uno scope morto. Misurato: con quella condizione il TUI partiva
                // lo stesso, con l'avviso di fallback — cioe' esattamente il
                // difetto che si voleva eliminare.
                if (err.isProgramMissing(e)) {
                  console.error(
                    `\n✗ il programma "${program}" non esiste su HackerOne.\n` +
                      `  Niente e' stato scritto. Controlla il nome e riprova.\n` +
                      `  Programmi in locale: ${elencoLocale() || "nessuno"}\n`,
                  )
                  process.exit(1)
                }
                // Secondo caso, trovato dalla verifica indipendente del
                // 2026-10-01: il fallback serve a non buttare via i dati buoni
                // di ieri. Se i dati non ci sono MAI stati il fallback e'
                // vuoto — l'agente parte con zero target e zero regole, cioe'
                // 800 MB di processo per non guardare nulla.
                //
                // Non e' la stessa cosa di "programma inesistente" (le cause
                // sono diverse e l'errore mostrato e' diverso), ma la
                // conclusione coincide: non si parte senza niente da guardare.
                // Nota che qui `config` puo' esistere senza `lastUpdated`: e'
                // un file non mai sincronizzato, non un programma in locale.
                if (unsynced && config === undefined) {
                  console.error(
                    `\n✗ non ho i dati di "${program}" e non sono riuscito a scaricarli.\n` +
                      `  La rete non ha risposto, quindi non posso dire se il programma esiste\n` +
                      `  ne' quali target sono in scope. Partire qui significherebbe\n` +
                      `  un agente con zero target da guardare.\n` +
                      `  Riprova quando hai rete, oppure:\n` +
                      `      bb sync ${program}\n`,
                  )
                  process.exit(1)
                }
                stale = fresh.staleNotice(program, fresh.ageHours(config?.lastUpdated), e)
                console.log(stale)
              }
            }
          }

          // `orphan` = la directory di un progetto esiste, ma il programma NON e'
          // in elenco. Distingue il bootstrap (progetto nuovo, programma mai
          // sincronizzato) dal lavoro abbandonato (un programma c'era, poi `bb
          // remove`). Senza questa distinzione un progetto nuovo riceveva anche
          // l'avviso "rimosso", che e' falso. Misurato il 2026-09-26.
          const orphan = unsynced && fs.existsSync(directory)

          // 2. Directory di progetto: si crea se manca. Il bootstrap si ferma
          //    qui — non lancia il primo crawl, lo lancia l'agente quando il
          //    messaggio glielo chiede.
          // La directory si crea SOLO se il programma esiste davvero (crearla
          // prima faceva si' che un refuso lasciasse una directory vuota, che il
          // lancio successivo scambiava per un progetto abbandonato) e SOLO se
          // non e' un dry-run: `--dry-run` non tocca il filesystem, se no non
          // e' un dry-run. Misurato il 2026-09-26.
          const existed = fs.existsSync(directory)
          // Niente `mkdir program`: la sottocartella non era letta da nessun
          // punto di src/ (unica occorrenza di `join(directory, "program")` era
          // questa riga stessa, misurata il 2026-09-29) e lasciava directory
          // vuote dentro i programmi reali. La directory del programma e'
          // gia' creata dal passo 2, che e' l'unica cosa servita.

          // 3. Stato: assente in un progetto nuovo, e non è un errore.
          //    Se e' proprio ASSENTE (non illegibile) e il programma e' valido,
          //    lo si INIZIALIZZA qui. Motivo misurato il 2026-09-28: `bb hunt`
          //    leggeva lo stato e basta, `BountyState.create()` non aveva alcun
          //    caller di produzione, e sui programmi reali non esisteva nessun
          //    `state.json`. Lo stato nasceva solo se l'AGENTE decideva di
          //    chiamare `bounty_status` — cioe' il confine dipendeva dalla
          //    cooperazione di chi doveva essere sorvegliato. Con lo stato
          //    creato qui, il gate di `todowrite` ha su che vigilare gia' alla
          //    prima sessione.
          //    Lo stato ILLEGGIBILE (corrotto) non si sovrascrive: propagare
          //    l'errore e' il comportamento B1, azzerarlo perderebbe prove.
          let state: BountyState.Info | undefined
          try {
            state = BountyState.read(directory)
          } catch (e) {
            // Un `Unreadable` puo' voler dire due cose: `state.json` non c'e'
            // (progetto nuovo, normale) oppure c'e' ed e' corrotto. Nel
            // secondo caso propagare e' la regola B1: sovrascrivere azzererebbe
            // in silenzio la fase dichiarata. Il discriminante non e' il tipo
            // dell'errore ma l'ESISTENZA del file.
            if (BountyState.fileExists(directory)) throw e
            state = undefined
          }
          if (!state && !args.dryRun) {
            state = BountyState.create({ directory, program })
            BountyState.write(state)
          }

          // 3b. I due file che l'agente legge all'arrivo: `AGENTS.md` (l'indice)
          //     e `scope.md` (cosa e' dentro e cosa no). Vengono riscritti a ogni
          //     avvio perche' lo scope cambia: lasciare un file di 20 giorni fa
          //     accanto a dati freschi e' peggio che non averlo.
          //     La policy integrale NON viene toccata: `bb sync` l'ha gia'
          //     scritta e duplicarla aprirebbe due fonti che divergono.
          if (config) {
            try {
              // La directory serve anche in `--dry-run`: e' l'unico modo di
              // vedere i documenti senza lanciare il TUI da 800MB. Senza questa
              // mkdir la scrittura falliva con ENOENT e il dry-run non mostrava
              // niente — cioe' il comando che serve a ispezionare, non mostrava.
              fs.mkdirSync(directory, { recursive: true })
              // `path.dirname(programsRoot)`, NON `programsRoot`: la policy la
              // scrive `bb sync` nella root di bugbounty, mentre `programsRoot`
              // e' la directory delle cartelle per-programma. Passando la
              // seconda, `AGENTS.md` dichiarava "policy non in locale" su un
              // file che esisteva — un rimando rotto su dati reali.
              writeProgramDocs(config, directory, path.dirname(programsRoot))
            } catch (e) {
              // I documenti sono un aiuto, non un prerequisito: se la scrittura
              // fallisce l'agente parte lo stesso e lo dice nel messaggio.
              console.error(`  ! non ho potuto scrivere i documenti del programma: ${(e as Error).message}`)
            }
          }

          // 4. Il perimetro. È QUI che il confine diventa effettivo: senza
          //    `diagnose()` un path con metacaratteri o una directory fuori dal
          //    progetto passerebbero, e `buildProjectRuleset` da solo non basta.
          const diagnosis = await ProjectPerimeter.diagnose(directory)
          // `isSafe` e' una lista POSITIVA (project.ts:417): un rischio non
          // previsto e' rifiutato per default invece di passare in silenzio.
          // Ignorarlo lascerebbe un perimetro costruito su un path in cui
          // l'autore non si fida. Misurato: senza questo controllo un path
          // traversal arrivava fino a costruire 9 regole su /tmp.
          if (!ProjectPerimeter.isSafe(diagnosis)) {
            UI.error(
              `Non posso costruire un perimetro affidabile per ${directory}: ${diagnosis.risk}.`,
            )
            if (diagnosis.warning) UI.error(diagnosis.warning)
            process.exit(1)
          }
          const rules = ProjectPerimeter.buildProjectRuleset(directory, diagnosis.worktree)

          const message = HuntContext.message({
            program,
            directory,
            config,
            state,
            unsynced,
            orphan,
            existed,
            stale,
          })

          if (args.dryRun) {
            // Nessuna sessione, nessun LLM: solo i dati, in chiaro. È il modo
            // per ispezionare il contesto e per farlo verificare.
            console.log("=== MESSAGGIO INIZIALE ===")
            console.log(message)
            console.log("\n=== PERIMETRO ===")
            console.log(`directory progetto: ${diagnosis.projectDir}`)
            console.log(`worktree: ${diagnosis.worktree ?? "(nessuno — non e' un repo git)"}`)
            console.log(`risk: ${diagnosis.risk}`)
            if (diagnosis.warning) console.log(`warning: ${diagnosis.warning}`)
            console.log(`regole: ${rules.length}`)
            for (const r of rules) {
              console.log(`  ${r.action}  ${r.permission ?? "-"}  ${r.pattern ?? ""}`.trimEnd())
            }
            console.log("\n=== STATO ===")
            console.log(HuntContext.summary(state))
            console.log(`\n(--dry-run: nessuna sessione creata, nessun modello interrogato)`)
            return
          }

          // 5. La sessione nasce QUI, col perimetro dentro. Il TUI crea una
          //    sessione da solo solo quando `sessionID` è assente
          //    (`tui/component/prompt/index.tsx:543`): pre-creandola e passing
          //    l'id, il TUI la riusa e non ne crea una vuota senza regole.
          // `bootstrap` serve perche' `createNext` legge `Instance.project`
          // (`session/index.ts:278`) e senza il context solleva
          // "No context found for instance" — crash misurato il 2026-09-26.
          const session = await bootstrap(directory, () =>
            Session.createNext({
              title: HuntContext.TITLE + " · " + program,
              directory,
              permission: rules,
            }),
          )

          // 6. Il TUI, quello di sempre: nessun canale nascosto, tutto passa per
          //    argomenti e per la sessione persistita.
          // Il TUI e' il comando DEFAULT (`command: "$0 [project]"`, tui/thread.ts:45), non un
          // sottocomando "thread": passargli "thread" avrebbe fatto stampare l'help.
          // `--project` = la directory del PROGRAMMA, non il cwd da cui l'utente
          // ha lanciato il comando. Il TUI fa `process.chdir(args.project)`
          // (tui/thread.ts:95): senza questo argomento l'agente parte dalla
          // cartella del terminale e `AGENTS.md` viene risolto sul posto
          // sbagliato — l'agente riceve le istruzioni del progetto da cui
          // l'utente e' partito, non quelle del programma di bug bounty.
          // Difetto misurato il 2026-09-29, non ipotizzato.
          const tuiArgs = [
            "--session",
            session.id,
            "--prompt",
            message,
            "--agent",
            args.agent,
            "--project",
            directory,
          ]
          // La root del package cyberstrike: da qui parte il TUI. Derivata da
          // questo file, non da cwd — l'utente puo' lanciare `bb hunt` da
          // qualsiasi directory e il TUI deve partire lo stesso.
          const pkgDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..")
          // `--conditions=browser` e' l'invocazione che usa anche lo script
          // `dev` del package: senza, il TUI (JSX) non risolve
          // `react/jsx-dev-runtime` e muore all'avvio. Misurato il 2026-09-26.
          // La forma e' quella dello script `dev` (package.json):
          //   bun run --conditions=browser ./src/index.ts
          // `run` + path RELATIVO, non il path assolto di argv: e' la
          // differenza fra un TUI che parte e "Cannot find module
          // react/jsx-dev-runtime" (misurato il 2026-09-26).
          const child = spawn(
            process.argv[0]!,
            ["run", "--conditions=browser", "./src/index.ts", ...tuiArgs],
            { stdio: "inherit", cwd: pkgDir },
          )
          child.on("close", (code: number | null) => {
            process.exit(code ?? 1)
          })
        },
      )
      // `demandCommand()` e' la convenzione degli altri 12 gruppi di comandi
      // del CLI (auth, mcp, session, provider, debug/*, ...): senza, `bb` da
      // solo cadeva nell'handler vuoto qui sotto e moriva con codice 1 e
      // ZERO byte di output — l'utente vedeva una riga vuota e un errore senza
      // spiegazione, peggio di non sapere che il comando esiste. Misurato con
      // il CLI reale il 2026-09-28 (locale it_IT: rc=1, 0 byte).
      .demandCommand(1),
  // Raggiungibile solo con un'azione valida, perche' `demandCommand` intercetta
  // il caso "nessuna azione". Resta perche' la sua forma vuota era il difetto:
  // `bb` da solo cadeva qui e moriva con codice 1 e ZERO byte di output
  // (misurato col CLI reale il 2026-09-28, LANG=it_IT.UTF-8) — l'utente
  // vedeva una riga vuota e un errore senza spiegazione.
  //
  // Se `demandCommand` smettesse di intercettare questo caso, l'help e' la
  // risposta utile a "cosa scrivo qui dentro?", non un errore secco.
  handler: async (args) => {
    void args
    await yargs().showHelp()
  },
})