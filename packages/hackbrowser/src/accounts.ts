// Autonomous account lifecycle for bug bounty registrations.
//
// The agent registers on targets by itself: when the planner sees a signup
// form, it plans filling it; executeFormTask detects email/password fields and
// substitutes AUTO_ACCOUNT values with per-program credentials generated with
// h1Alias()/generatePassword() (H1-attributable alias + site-compliant
// password). The planner prompt tells the LLM to use the literal marker
// AUTO_ACCOUNT_EMAIL / AUTO_ACCOUNT_PASSWORD when it identifies a signup form
// — so the LLM never sees or invents real credentials.
//
// Lifecycle: accounts land in `pending` until the user approves them
// (`bb accounts approve`); approved ones can be reused for login flows.
// Verification codes remain human-in-the-loop (plus-alias → real inbox,
// agent asks via request-help when the site demands a code).

import fs from "fs"
import path from "path"
import os from "os"
import {
  h1Alias,
  generatePassword,
  type PasswordPolicy,
} from "./bbmail.ts"
import { loadHunterCredentials } from "./bugbounty.ts"

export type AccountStatus = "pending" | "approved" | "disabled"

export interface ManagedAccount {
  email: string
  password: string
  program: string
  target: string
  status: AccountStatus
  createdAt: string
  verifiedAt?: string
}

function accountsPath(program: string): string {
  const dir =
    process.env.CYBERSTRIKE_HOME || path.join(os.homedir(), ".cyberstrike")
  return path.join(dir, "bugbounty", `${program}.accounts.json`)
}

export function loadManagedAccounts(program: string): ManagedAccount[] {
  const p = accountsPath(program)
  if (!fs.existsSync(p)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { accounts?: ManagedAccount[] }
    return parsed.accounts ?? []
  } catch {
    return []
  }
}

function persistAccounts(program: string, accounts: ManagedAccount[]): void {
  fs.mkdirSync(path.dirname(accountsPath(program)), { recursive: true })
  fs.writeFileSync(accountsPath(program), JSON.stringify({ accounts }, null, 2), { mode: 0o600 })
}

export function setAccountStatus(program: string, email: string, status: AccountStatus): boolean {
  const accounts = loadManagedAccounts(program)
  const acc = accounts.find((a) => a.email === email)
  if (!acc) return false
  acc.status = status
  if (status === "approved") acc.verifiedAt = acc.verifiedAt ?? new Date().toISOString()
  persistAccounts(program, accounts)
  return true
}

/** Marker values the planner prompt tells the LLM to fill signup forms with. */
export const AUTO_ACCOUNT_EMAIL = "AUTO_ACCOUNT_EMAIL"
export const AUTO_ACCOUNT_PASSWORD = "AUTO_ACCOUNT_PASSWORD"

export interface AutoAccountOptions {
  program: string
  /** Target host the account is for (stored for correlation). */
  target: string
  /** Password policy from the site's own constraints. */
  policy?: PasswordPolicy
}

/**
 * Ensure a usable account exists for this program+target: reuse an approved
 * one, or generate a fresh pending account. Returns null when no identity
 * is configured (bb connect) — the caller then skips autonomous registration.
 */
export function ensureAutoAccount(opts: AutoAccountOptions): ManagedAccount | null {
  const creds = loadHunterCredentials()
  if (!creds?.h1_username || !creds?.base_email) return null

  const existing = loadManagedAccounts(opts.program)
  const reusable = existing.find((a) => a.status === "approved" && a.target === opts.target)
  if (reusable) return reusable

  const email = h1Alias({ base: creds.base_email, username: creds.h1_username, program: opts.program })
  // Don't duplicate: if the alias already exists (any status), reuse it with a fresh password only when disabled.
  const dupe = existing.find((a) => a.email === email)
  if (dupe && dupe.status !== "disabled") return dupe

  const account: ManagedAccount = {
    email,
    password: generatePassword(opts.policy ?? {}),
    program: opts.program,
    target: opts.target,
    status: "pending",
    createdAt: new Date().toISOString(),
  }
  existing.push(account)
  persistAccounts(opts.program, existing)
  return account
}

// ============================================================
// Form-field interception (called from agent.ts executeFormTask)
// ============================================================

/**
 * Decide the value for a form field. Signup-markers are replaced with real
 * generated credentials (creating the account lazily on first use); an email
 * field without markers uses an existing approved account when available.
 * Returns the original value untouched when nothing applies.
 */
export function resolveFieldValue(
  field: { label: string; type?: string; value: string },
  program: string,
  target: string,
  policy?: PasswordPolicy,
): string {
  const isEmailField =
    field.type === "email" ||
    /e.?mail/i.test(field.label) ||
    (field.value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(field.value))
  const isPasswordField = field.type === "password" || /pass(word)?/i.test(field.label)

  if (field.value === AUTO_ACCOUNT_EMAIL || (isEmailField && !field.value)) {
    const acc = ensureAutoAccount({ program, target })
    return acc?.email ?? field.value
  }
  if (field.value === AUTO_ACCOUNT_PASSWORD || (isPasswordField && !field.value)) {
    const acc = ensureAutoAccount({ program, target, policy })
    return acc?.password ?? field.value
  }
  return field.value
}
