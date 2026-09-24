// E2E test driver: replicates the `cyberstrike hackbrowser <url> --bugbounty-program X`
// CLI handler exactly, minus the interactive TUI. Exercises the full chain:
// launcher → fork-built worker subprocess → runCrawl → BugBountyManager →
// scope application → Bug Bounty planner prompt → real browser + LLM crawl.

import { bootstrap } from "./src/cli/bootstrap"
import { Server } from "./src/server/server"
import { createCyberstrikeClient } from "@cyberstrike-io/sdk/v2"
import { launchHackbrowser, stopHackbrowser } from "./src/tool/hackbrowser-launcher"
import { HackbrowserStatus } from "./src/session/hackbrowser-status"
import { Log } from "./src/util/log"

const program = process.argv[2] ?? "smoketest"
const target = process.argv[3] ?? "https://example.com"
const steps = Number(process.argv[4] ?? 3)

Log.init({ level: "INFO", print: true })
const log = Log.create({ service: "bb-e2e-test" })

await bootstrap(process.cwd(), async () => {
  const server = Server.listen({ port: 0, hostname: "127.0.0.1" })
  const serverUrl = server.url.toString().replace(/\/$/, "")
  log.info("server up", { serverUrl })

  const sdk = createCyberstrikeClient({ baseUrl: serverUrl, directory: process.cwd() })
  const sessionResult = await sdk.session.create({ title: `bb-e2e: ${target}` })
  const sessionID = sessionResult.data?.id
  if (!sessionID) throw new Error("Failed to create session")
  log.info("session created", { sessionID })

  const kickOff = await launchHackbrowser({
    target,
    sessionID,
    bugbountyProgram: program, // <-- the flag under test
    steps,
    headless: true,
  })
  if (!kickOff.started) throw new Error(`kickoff failed: ${kickOff.message}`)
  log.info("crawl started", { message: kickOff.message })

  // Poll HackbrowserStatus until terminal phase
  const t0 = Date.now()
  let last = ""
  while (Date.now() - t0 < 10 * 60 * 1000) {
    const status = HackbrowserStatus.get(sessionID)
    if (status) {
      const line = `${status.phase} pages=${status.pagesExplored} endpoints=${status.capturedEndpoints}`
      if (line !== last) {
        log.info("status", { line })
        last = line
      }
      if (status.phase === "completed" || status.phase === "failed") {
        log.info("final", {
          phase: status.phase,
          pagesExplored: status.pagesExplored,
          capturedEndpoints: status.capturedEndpoints,
          errors: status.errors,
        })
        console.log("\n=== RISULTATO E2E ===")
        console.log(`phase:            ${status.phase}`)
        console.log(`pagesExplored:    ${status.pagesExplored}`)
        console.log(`capturedEndpoints:${status.capturedEndpoints}`)
        console.log(`errors:           ${JSON.stringify(status.errors)}`)
        process.exit(status.phase === "completed" ? 0 : 1)
      }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  log.warn("timeout — stopping crawl")
  stopHackbrowser(sessionID)
  process.exit(2)
})
