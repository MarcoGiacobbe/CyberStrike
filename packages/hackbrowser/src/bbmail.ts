// Temporary email aliases + site-compliant password generation for bug bounty
// registrations. HackerOne directive: automated/registration traffic should be
// attributable to the hunter — the alias convention encodes BOTH the hunter's
// H1 username and the program handle in a plus-tag of the hunter's real
// mailbox (e.g. marco+marcotest.bcny@gmail.com), so:
//   1. every program gets a unique, correlatable address
//   2. verification mail lands in the hunter's REAL inbox (nothing to poll —
//      the human reads codes there; the agent asks for them when needed)
// Credentials are stored per-program in <program>.accounts.json (chmod 600).

import fs from "fs"
import path from "path"
import os from "os"
import { randomInt } from "crypto"

// ============================================================
// Alias generation (HackerOne identification directive)
// ============================================================

/**
 * Build a program-specific alias from the hunter's base address.
 * Default template: {local}+{username}.{program}@{domain}
 *   base "marco@gmail.com", username "marcotest", program "bcny"
 *     → "marco+marcotest.bcny@gmail.com"
 * An existing +tag in the base is replaced, not nested.
 */
export function h1Alias(opts: {
  base: string
  username: string
  program: string
  template?: string
}): string {
  const at = opts.base.indexOf("@")
  if (at <= 0 || at === opts.base.length - 1) {
    throw new Error(`base address must be local@domain, got: "${opts.base}"`)
  }
  const domain = opts.base.slice(at + 1)
  const local = opts.base.slice(0, at).split("+")[0]! // strip any existing +tag
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "")
  const template =
    opts.template ?? "{local}+{username}.{program}@{domain}"
  const alias = template
    .replaceAll("{local}", local)
    .replaceAll("{username}", clean(opts.username))
    .replaceAll("{program}", clean(opts.program))
    .replaceAll("{domain}", domain)
  if (!alias.includes("@")) throw new Error("alias template lost the domain")
  return alias
}

// ============================================================
// Password generation (site-directive compliant)
// ============================================================

export interface PasswordPolicy {
  minLength?: number
  maxLength?: number
  requireUpper?: boolean
  requireLower?: boolean
  requireDigit?: boolean
  requireSpecial?: boolean
  allowedSpecial?: string
  // Exclude look-alikes (0O1lI) — default true. Turn off only if the site
  // forbids... nothing, really; it's for human retyping.
  avoidAmbiguous?: boolean
}

const LOWER = "abcdefghijklmnopqrstuvwxyz"
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const DIGIT = "0123456789"
const DEFAULT_SPECIAL = "!@#$%^&*()-_=+"
const AMBIGUOUS = new Set([..."0O1lI|"])

/**
 * Generate a random password satisfying the policy. Defaults: 16 chars,
 * all four classes required, ambiguous chars excluded.
 * Throws when the policy is impossible (maxLength below required classes).
 */
export function generatePassword(policy: PasswordPolicy = {}): string {
  const minLength = policy.minLength ?? 16
  const maxLength = policy.maxLength ?? Math.max(minLength, 64)
  const length = Math.max(Math.min(minLength, maxLength), 1)
  const strip = (pool: string) =>
    policy.avoidAmbiguous === false ? pool : [...pool].filter((c) => !AMBIGUOUS.has(c)).join("")
  const pools: Array<[boolean, string]> = [
    [policy.requireLower !== false, strip(LOWER)],
    [policy.requireUpper !== false, strip(UPPER)],
    [policy.requireDigit !== false, strip(DIGIT)],
    [policy.requireSpecial !== false, strip(policy.allowedSpecial ?? DEFAULT_SPECIAL)],
  ]
  const active = pools.filter(([req]) => req).map(([, pool]) => pool)
  if (active.some((p) => p.length === 0)) throw new Error("a required character class is empty")
  if (maxLength < active.length) {
    throw new Error(`maxLength ${maxLength} cannot fit ${active.length} required character classes`)
  }
  const all = [...new Set(active.join(""))].join("")
  const pick = (pool: string) => pool[randomInt(pool.length)]!
  const chars = active.map(pick)
  while (chars.length < length) chars.push(pick(all))
  // Fisher–Yates with crypto randomness
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  const out = chars.slice(0, length).join("")
  // Self-check: every required class present (shuffle must not have destroyed it)
  for (const [req, pool] of pools) {
    if (req && ![...out].some((c) => pool.includes(c))) {
      throw new Error("generated password failed its own policy — bug")
    }
  }
  return out
}

/**
 * Parse the scanner's constraint string ("minlength:8 maxlength:64", also
 * accepts min/max) into a PasswordPolicy. Unknown tokens are ignored, so it
 * tolerates the full constraint format ("min:0 max:1000 step:10").
 */
export function policyFromConstraints(constraints: string): PasswordPolicy {
  const policy: PasswordPolicy = {}
  const min = constraints.match(/(?:minlength|min):(\d+)/)
  const max = constraints.match(/(?:maxlength|max):(\d+)/)
  if (min) policy.minLength = Number(min[1])
  if (max) policy.maxLength = Number(max[1])
  return policy
}

// ============================================================
// Per-program account store (<name>.accounts.json, chmod 600)
// ============================================================

export interface MailAccount {
  email: string
  password: string
  target?: string
  createdAt: string
  verified?: boolean
}

function accountsPath(program: string): string {
  const dir =
    process.env.CYBERSTRIKE_HOME || path.join(os.homedir(), ".cyberstrike")
  return path.join(dir, "bugbounty", `${program}.accounts.json`)
}

export function loadAccounts(program: string): MailAccount[] {
  const p = accountsPath(program)
  if (!fs.existsSync(p)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { accounts?: MailAccount[] }
    return parsed.accounts ?? []
  } catch {
    return []
  }
}

/** Append an account to the program's store (chmod 600 on the file). */
export function saveAccount(program: string, account: MailAccount): void {
  const p = accountsPath(program)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const accounts = loadAccounts(program)
  accounts.push(account)
  fs.writeFileSync(p, JSON.stringify({ accounts }, null, 2), { mode: 0o600 })
}
