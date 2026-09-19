// BrowserSkill integration module
// Wraps the `bsk` CLI tool for browser automation via real browser sessions.
// Provides functions to execute browser commands and return structured results.

import { execFile } from "child_process"
import { Log } from "./log.ts"

const log = Log.create({ service: "hackbrowser:browserskill" })

/**
 * Execute a bsk command and return the result as JSON.
 * Throws an error if the command fails or output is not valid JSON.
 */
export function executeBskCommand(command: string, args: string[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    log.debug("executing bsk command", { command, args })

    const child = execFile("bsk", [command, ...args], {
      timeout: 60000, // 60 second timeout
      maxBuffer: 1024 * 1024, // 1MB output buffer
    })

    let stdout = ""
    let stderr = ""

    child.stdout?.on("data", (data) => {
      stdout += data.toString()
    })

    child.stderr?.on("data", (data) => {
      stderr += data.toString()
    })

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`bsk ${command} failed with code ${code}: ${stderr}`))
        return
      }

      try {
        const result = JSON.parse(stdout.trim())
        resolve(result)
      } catch (e) {
        reject(new Error(`Failed to parse bsk output as JSON: ${stdout}`))
      }
    })

    child.on("error", (err) => {
      reject(err)
    })
  })
}

/**
 * Take a screenshot of the current page.
 */
export async function screenshot(): Promise<string> {
  const result = await executeBskCommand("screenshot")
  return result.data
}

/**
 * Get the current page URL.
 */
export async function getUrl(): Promise<string> {
  const result = await executeBskCommand("url")
  return result.data
}

/**
 * Evaluate JavaScript in the current page context.
 * @param js JavaScript code to evaluate
 * @returns JSON-serializable result from the evaluation
 */
export async function evalInPage(js: string): Promise<any> {
  const result = await executeBskCommand("eval", [js])
  return result.data
}

/**
 * Click an element by CSS selector.
 */
export async function click(selector: string): Promise<void> {
  await executeBskCommand("click", [selector])
}

/**
 * Fill a form field by CSS selector.
 */
export async function fill(selector: string, value: string): Promise<void> {
  await executeBskCommand("fill", [selector, value])
}

/**
 * Submit a form by CSS selector.
 */
export async function submit(selector: string): Promise<void> {
  await executeBskCommand("submit", [selector])
}

/**
 * Check if BrowserSkill is available and installed.
 */
export async function isBrowserSkillAvailable(): Promise<boolean> {
  try {
    await executeBskCommand("--version")
    return true
  } catch (e) {
    return false
  }
}