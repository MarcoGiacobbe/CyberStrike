// BrowserSkill integration — wraps the real `bsk` CLI (https://github.com/Tencent/BrowserSkill)
// to drive the user's actual browser session. Use for human-in-the-loop flows
// (2FA, CAPTCHA via `request-help`) and login-state reuse that Playwright can't do.
//
// Command surface verified against `bsk --help`: navigate, click, fill, evaluate,
// screenshot, snapshot, get-html, console, network, request-help, wait-for-navigation,
// wait-ms, press, select. Global flag `--json` emits machine-readable output.

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

/** Navigate the agent window's tab to a URL. */
export const navigate = (url: string) => bsk(["navigate", url])

/** Click a snapshot ref or CSS selector. */
export const click = (ref: string) => bsk(["click", ref])

/** Fill an input / textarea / contenteditable. */
export const fill = (ref: string, value: string) => bsk(["fill", ref, value])

/** Evaluate a JavaScript expression inside the agent window. */
export const evaluate = (js: string) => bsk(["evaluate", js])

/** Capture a PNG of the viewport (returns output path). */
export const screenshot = () => bsk(["screenshot"])

/** Produce an aria-snapshot with @eN refs — the LLM-friendly page view. */
export const snapshot = () => bsk(["snapshot"])

/** Dump raw HTML for the current tab. */
export const getHtml = () => bsk(["get-html"])

/** Read buffered console/log/exception messages. */
export const console_ = () => bsk(["console"])

/** Read buffered network responses / failures. */
export const network = () => bsk(["network"])

/**
 * Ask the human to complete an in-page step (CAPTCHA / login / confirm).
 * Blocks until the human resolves it — this is the human-in-the-loop escape hatch.
 */
export const requestHelp = (instruction: string) => bsk(["request-help", instruction], 15 * 60 * 1000)

/** Wait for a page-lifecycle event (e.g. "load", "networkidle"). */
export const waitForNavigation = (event: string) => bsk(["wait-for-navigation", event])

/** Set <select> option values by value attribute. */
export const select = (ref: string, ...values: string[]) => bsk(["select", ref, ...values])

/** Dispatch a keyboard key combo. */
export const press = (combo: string) => bsk(["press", combo])
