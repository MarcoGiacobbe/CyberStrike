# CyberStrike Fork - Bug Bounty Enhancement Plan

## Objective
Enhance CyberStrike's hackbrowser for autonomous Bug Bounty hunting by:
1. Supporting Bug Bounty program configuration (scope, payouts, known issues, rules)
2. Integrating HackerOne API for automatic program data sync
3. Integrating Tencent BrowserSkill for real-browser sessions
4. Making the system prompt adaptable to Bug Bounty context

## Fork Info
- Fork: https://github.com/MarcoGiacobbe/CyberStrike
- Branch: `feat/bug-bounty-enhancement`
- Working directory: /home/marco/hermes/cyberstrike-fork/CyberStrike

## Architecture Decisions

### Dual-Mode Browser Support
- **HackBrowser (Playwright)**: Default mode for unattended crawling, systematic testing, CI/CD
- **BrowserSkill (Tencent)**: Optional mode (`--browser-skill`) for real-browser sessions with:
  - User's actual login state
  - Human-in-the-loop for 2FA/CAPTCHA
  - Real user-agent

### Bug Bounty Program Management
- CLI commands: `bb list`, `bb info <name>`, `bb add <name>`, `bb sync <name>`, `bb crawl <name>`
- Program config stored in `~/.cyberstrike/bugbounty/<name>.json`
- Auto-sync from HackerOne API when connected

### System Prompt Adaptability
- Generic security testing prompt (current)
- Bug Bounty context-aware prompt (when program config is loaded)
- Dynamic injection of: scope, known issues, payout tiers, program rules

## Implementation Phases

### Phase 1: Fork setup ✅ DONE
- Fork created
- Branch created
- Upstream remote configured

### Phase 2: Bug Bounty Program Config
- Create program config schema
- CLI commands for program management
- HackerOne API integration (scope, rules, known issues, payouts)

**NOTE (placeholder):** i campi dinamici del prompt bugbounty.txt
(`{program_name}`, `{platform}`, `{scope_in}`, `{scope_out}`, `{known_issues}`,
`{payout_focus}`) sono per ora riempiti dal JSON locale in
`~/.cyberstrike/bugbounty/<name>.json`. Quando implementiamo il download/sync
automatico dei programmi da HackerOne (fase `bb sync`), dobbiamo verificare
che questi placeholder vengano popolati con i dati REALI estratti dalle pagine
SCOPE / KNOWN ISSUES / REGOLE / BOUNTY del programma, e valutare se servono
nuovi placeholder (es. regole del programma, asset out-of-scope espliciti).

### Phase 3: BrowserSkill Integration
- BrowserSkill as optional backend
- Human-in-the-loop via BrowserSkill's request-help
- Auto-detection of when to use which backend

### Phase 4: Adaptive System Prompt
- Bug Bounty context-aware planning
- Payout-optimized exploration
- Scope enforcement in prompt
- Known issue filtering in prompt

### Phase 5: Report Generation
- HackerOne/Bugcrowd formatted reports
- Auto-detection of vulnerability type
- Payout estimation

## Key Features

### CLI Usage
```bash
# Connect to HackerOne
cyberstrike bb connect hackerone --username hunter@example.com

# List programs
cyberstrike bb list

# Sync program data
cyberstrike bb sync stripe

# Crawl with program context
cyberstrike bb crawl stripe --target https://dashboard.stripe.com
```

### HackBrowser CLI Usage
```bash
# Standard crawl
cyberstrike hackbrowser https://target.com --scope "*.target.com"

# With Bug Bounty program
cyberstrike hackbrowser https://target.com --bugbounty-program stripe
```

## Browser Comparison

| Feature | HackBrowser (Playwright) | BrowserSkill (Tencent) |
|---|---|---|
| Browser | Chromium (fresh) | User's Chrome |
| Login | Fresh or auto | User's session |
| 2FA | Limited | Human-in-the-loop |
| Control | Full programmatic | Via bsk CLI |
| Unattended | Yes | No |
| User-agent | Playwright | Real UA |
| Use case | Systematic testing | Complex auth |
