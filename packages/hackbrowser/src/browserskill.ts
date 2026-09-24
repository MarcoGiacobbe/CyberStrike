// BrowserSkill integration — wraps the real `bsk` CLI (https://github.com/Tencent/BrowserSkill)
// to drive the user's actual browser session. Use for human-in-the-loop flows
// (2FA, CAPTCHA via `request-help`) and login-state reuse that Playwright can't do.
//
// bsk model: a daemon owns browser connections; commands that act on a tab are
// session-scoped and require `--session <id>`. Sessions are created with
// `bsk session start` and this wrapper resolves/reuses one automatically.
//
// Command surface verified against `bsk --help`: session, navigate, click, fill,
// evaluate, screenshot, snapshot, get-html, console, network, request-help,
// wait-for-navigation, wait-ms, press, select. Global flag `--json` for
// machine-readable output.

import { execFile } from "child_process"
import { Log } from "./log.ts"

const log = Log.create({ service: "hackbrowser:browserskill" })

/** Run `bsk <args...>` and return parsed JSON (--json) or raw stdout. */
function bsk(args: string[], timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    log.debug("bsk exec", { args })
    execFile("bsk", [...args, "--json"], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`bsk ${args.join(" ")} failed: ${stderr || err.message}`))
        return
      }
      const text = stdout.trim()
      if (!text) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        // Not all commands emit JSON even with --json — return raw text.
        resolve(text)
      }
    })
  })
}

// Active session id — resolved lazily, reused across calls.
let session: string | null = null

/**
 * Resolve the active bsk session: reuse the first existing session or start
 * a new one against the connected browser. Cached — subsequent calls are free.
 */
export async function getSession(): Promise<string> {
  if (session) return session
  const sessions = await bsk(["session", "list"])
  if (Array.isArray(sessions) && sessions.length > 0 && sessions[0]?.session_id) {
    const reused: string = sessions[0].session_id
    session = reused
    log.debug("reusing bsk session", { session: reused })
    return reused
  }
  const started = await bsk(["session", "start"])
  if (!started?.session_id) throw new Error("bsk session start returned no session_id")
  const fresh: string = started.session_id
  session = fresh
  log.debug("started bsk session", { session: fresh })
  return fresh
}
/** Run a tab-scoped command with the auto-resolved session (--session is a subcommand flag). */
async function tab(args: string[], timeoutMs = 60000): Promise<any> {
  const s = await getSession()
  return bsk([...args, "--session", s], timeoutMs)
}

/** Check the bsk daemon is installed and running. */
export async function available(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("bsk", ["status", "--json"], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        log.warn("browserskill not available", { err: String(err) })
        resolve(false)
        return
      }
      log.debug("bsk status", { stdout: String(stdout).slice(0, 200) })
      resolve(true)
    })
  })
}

/** Navigate the session's tab to a URL. */
export const navigate = (url: string) => tab(["navigate", url])

/** Click a snapshot ref or CSS selector. */
export const click = (ref: string) => tab(["click", ref])

/** Fill an input / textarea / contenteditable. */
export const fill = (ref: string, value: string) => tab(["fill", ref, value])

/** Evaluate a JavaScript expression inside the session's tab — returns the raw value. */
export async function evaluate(js: string) {
  const r = await tab(["evaluate", js])
  // bsk wraps the result as {ok, tab_id, value} — unwrap for direct use.
  return r && typeof r === "object" && "value" in r ? r.value : r
}

/** Capture a PNG of the viewport (returns output path). */
export const screenshot = () => tab(["screenshot"])

/** Produce an aria-snapshot with @eN refs — the LLM-friendly page view. */
export const snapshot = () => tab(["snapshot"])

/** Dump raw HTML for the session's tab. */
export const getHtml = () => tab(["get-html"])

/** Read buffered console/log/exception messages. */
export const console_ = () => tab(["console"])

/** Read buffered network responses / failures. */
export const network = () => tab(["network"])

/**
 * Ask the human to complete an in-page step (CAPTCHA / login / confirm).
 * Blocks until the human resolves it — this is the human-in-the-loop escape hatch.
 */
export const requestHelp = (instruction: string) =>
  tab(["request-help", instruction], 15 * 60 * 1000)

/** Wait for a page-lifecycle event (load, domcontentloaded, networkidle, commit). */
export const waitForNavigation = (event = "load") => tab(["wait-for-navigation", "--wait-until", event])

/** Set <select> option values by value attribute. */
export const select = (ref: string, ...values: string[]) => tab(["select", ref, ...values])

/** Dispatch a keyboard key combo. */
export const press = (combo: string) => tab(["press", combo])
