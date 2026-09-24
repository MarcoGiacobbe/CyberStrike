// Bug Bounty Program Manager
// Manages bug bounty program configurations, scope, and rules.
//
// Usage:
//   const bb = new BugBountyManager();
//   bb.loadProgram("google");
//   const config = bb.getProgramConfig();
//   const inScope = bb.isInScope("https://www.google.com/search");

import fs from "fs";
import path from "path";
import os from "os";

export interface BountyProgramConfig {
  // Program identifier
  name: string;

  // Platform and URLs
  platform?: "hackerone" | "bugcrowd" | "intigriti" | "custom";
  programUrl?: string;
  triageUrl?: string;

  // Scope
  scope: {
    // In-scope targets
    in: string[];
    // Out-of-scope targets
    out: string[];
    // Optional: regex patterns for scope
    patterns?: string[];
  };

  // Rules
  rules?: {
    // Max steps per target
    maxSteps?: number;
    // Timeout per target
    timeoutMs?: number;
    // Require authentication
    authenticated?: boolean;
    // Custom rules
    custom?: string[];
  };

  // Payout info
  payouts?: {
    low: string;
    medium: string;
    high: string;
    critical: string;
  };

  // Known issues to exclude
  knownIssues?: {
    id: string;
    title: string;
    url?: string;
    status: "open" | "resolved" | "duplicate";
  }[];

  // Credentials
  credentials?: {
    username: string;
    password: string;
  };

  // Hunter identity — disclosed automation per program rules. When a program's
  // policy asks to identify automated traffic (e.g. "include your H1 username
  // in the User-Agent" or a custom header), configure it here; the crawler
  // applies it from the FIRST request of every crawl of this program.
  identity?: {
    // HackerOne username (or any platform handle) to disclose
    h1_username?: string;
    // Custom header name the program requires (e.g. "X-HackerOne-Username").
    // Omit when the program only asks for UA disclosure.
    header_name?: string;
    // UA template with {username} placeholder. Default when omitted:
    // "CyberStrike-BB/1.0 (H1: {username})"
    user_agent_template?: string;
  };

  // Metadata
  lastUpdated?: string;
  description?: string;
}

export class BugBountyManager {
  private programsDir: string;
  private currentProgram: string | null = null;
  private programConfigs: Map<string, BountyProgramConfig> = new Map();

  constructor() {
    // os.homedir() — a literal "~" in a path is never expanded by fs APIs.
    this.programsDir = path.join(process.env.CYBERSTRIKE_HOME || path.join(os.homedir(), ".cyberstrike"), "bugbounty");
    this.ensureProgramsDir();
  }

  private ensureProgramsDir(): void {
    if (!fs.existsSync(this.programsDir)) {
      fs.mkdirSync(this.programsDir, { recursive: true });
    }
  }

  /**
   * List all configured bug bounty programs
   */
  listPrograms(): string[] {
    // Programs are stored as flat <name>.json files — not directories.
    return fs
      .readdirSync(this.programsDir)
      .filter((e) => e.endsWith(".json"))
      .map((e) => e.replace(/\.json$/, ""));
  }

  /**
   * Load a bug bounty program configuration
   */
  loadProgram(name: string): boolean {
    const programPath = path.join(this.programsDir, `${name}.json`);

    if (!fs.existsSync(programPath)) {
      throw new Error(`Program '${name}' not found. Run 'bb program add' to add it.`);
    }

    const raw = fs.readFileSync(programPath, "utf8");
    const config: BountyProgramConfig = JSON.parse(raw);

    this.programConfigs.set(name, config);
    this.currentProgram = name;
    return true;
  }

  /**
   * Get the currently loaded program config
   */
  getProgramConfig(): BountyProgramConfig | null {
    if (!this.currentProgram) {
      return null;
    }
    return this.programConfigs.get(this.currentProgram) || null;
  }

  /**
   * Check if a URL is in scope for the current program
   */
  isInScope(url: string): boolean {
    const config = this.getProgramConfig();
    if (!config) {
      return true; // No program loaded, everything is in scope
    }

    // Check in-scope patterns first
    const inScopePatterns = config.scope.in;
    for (const pattern of inScopePatterns) {
      if (url.match(pattern)) {
        // Check if also matches out-of-scope (takes precedence)
        if (this.isOutOfScope(url)) {
          return false;
        }
        return true;
      }
    }

    // If no in-scope patterns defined, everything is in scope unless explicitly out
    return inScopePatterns.length === 0 || !this.isOutOfScope(url);
  }

  /**
   * Check if a URL is out of scope for the current program
   */
  isOutOfScope(url: string): boolean {
    const config = this.getProgramConfig();
    if (!config) {
      return false;
    }

    for (const pattern of config.scope.out) {
      if (url.match(pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get known issues to exclude from reporting
   */
  getKnownIssues(): BountyProgramConfig["knownIssues"] {
    const config = this.getProgramConfig();
    return config?.knownIssues || [];
  }

  /**
   * Add a new bug bounty program
   */
  addProgram(name: string, config: BountyProgramConfig): void {
    const programPath = path.join(this.programsDir, `${name}.json`);
    const data = JSON.stringify(config, null, 2);
    fs.writeFileSync(programPath, data);
  }

  /**
   * Remove a bug bounty program
   */
  removeProgram(name: string): void {
    const programPath = path.join(this.programsDir, `${name}.json`);
    fs.unlinkSync(programPath);
  }
}

// Singleton instance
let bbManager: BugBountyManager | null = null;

export function getBugBountyManager(): BugBountyManager {
  if (!bbManager) {
    bbManager = new BugBountyManager();
  }
  return bbManager;
}

// ============================================================
// Global hunter credentials (~/.cyberstrike/bugbounty/credentials.json)
// ============================================================

/** Shape of the global credentials file written by `bb connect`. */
export interface HunterCredentials {
  h1_username?: string;
  api_identifier?: string;
  api_token?: string;
}

function credentialsPath(): string {
  return path.join(
    process.env.CYBERSTRIKE_HOME || path.join(os.homedir(), ".cyberstrike"),
    "bugbounty",
    "credentials.json",
  );
}

/** Load global hunter credentials, or null when `bb connect` was never run. */
export function loadHunterCredentials(): HunterCredentials | null {
  const p = credentialsPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as HunterCredentials;
  } catch {
    return null;
  }
}

/** Save global hunter credentials with owner-only permissions (chmod 600). */
export function saveHunterCredentials(creds: HunterCredentials): void {
  const p = credentialsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
}