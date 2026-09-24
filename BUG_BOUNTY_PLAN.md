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

**HackerOne auth (verificato sui docs, 2026-09-24):** la Hacker API usa HTTP
Basic Auth con API token personale (Settings → API Tokens, anche su Community
gratuita). NIENTE OAuth. Endpoint utili:
- `GET /v1/hackers/programs` — lista programmi
- `GET /v1/hackers/programs/{handle}` — policy (= regole)
- `GET /v1/hackers/programs/{handle}/structured_scopes` — scope + eligible_for_bounty
- Hacktivity filtrato per handle — known issues pubbliche
Rate limit: 600 read/min (structured_scopes: 50/min).

## Test Results (2026-09-24, sessione di test completa)

Setup: app locale su localhost:4545 (3 pagine + 2 form POST) e programma
`bbtest` con scope localhost. Driver: `packages/cyberstrike/bb-e2e-test.ts`.

| Test | Esito | Evidenza |
|---|---|---|
| Unit test hackbrowser | ✅ 99/99 | bun test |
| Typecheck | ✅ 11/11 | bun turbo typecheck |
| CLI bb add/list/info/remove | ✅ | binario reale |
| Flag --bugbounty-program | ✅ | help |
| BrowserSkill wrapper (live) | ✅ | navigate/evaluate/snapshot su example.com |
| E2E single-cred | ✅ | 4 pagine, plan 3 task, POST /api/subscribe + /api/search catturati, errors=[] |
| Scope dal programma | ✅ | "applied bug bounty scope [\"*.localhost\"]" |
| Validazione headless+multiCred | ✅ | rifiutato con messaggio corretto |
| Multi-cred BFS + page-diff | ✅ strutturale | contexts=[admin,user], visitedBy, fingerprintMatch; poi stop per API key fittizia → errore propagato in errors[] (isAuthError OK) |
| bb crawl via TUI | ⚠️ | gira ma il log è ANSI; usare bb-e2e-test.ts per verifiche |
| Plan LLM con crediti | ✅ | 3 task su home; 402 solo dal proxy-agent CyberStrike (non nostro) |

**Gap trovato:** `launchHackbrowser` ignora silenziosamente `multiCredentials`
(non è in LauncherOptions) — il multi-cred funziona via `runCrawl` diretto ma
non dal launcher TUI. Da aggiungere al launcher se serve multi-cred via TUI.

**Nota credits:** OpenRouter senza crediti blocca il proxy-agent di CyberStrike
(orchestratore), NON il planner hackbrowser (che usa il modello iniettato).

### Test su programma REALE: bcny (The Browser Company) — 2026-09-24 ✅

Programma: https://hackerone.com/bcny (Gold Standard Safe Harbor, scope reale:
company.thebrowser.arc, thebrowser.company, bcny.com, arc.net, diabrowser.com;
payout Low $100 → Critical $20k). JSON popolato a mano come farà `bb sync`.

Crawl E2E su https://bcny.com, 6 step, autorizzazione utente esplicita.

| Aspetto | Risultato |
|---|---|
| Caricamento programma reale | ✅ `loaded bug bounty program bcny` |
| Scope reale applicato | ✅ 5 domini → `["*.company.thebrowser.arc","*.thebrowser.company","*.bcny.com","*.arc.net","*.diabrowser.com"]` |
| Redirect cross-dominio in scope | ✅ bcny.com → www.thebrowser.company seguito correttamente |
| Planner su sito reale (SPA) | ✅ FAQ: click su Question 2-6, CLOSE, THEME; su diabrowser.com plan 4 task ("Watch the scream"...) |
| Errori click gestiti | ✅ timeout 2s su alcuni bottoni FAQ → warn + crawl prosegue senza crash |
| Risultato finale | ✅ `completed, pagesExplored=6, capturedEndpoints=6, errors=[]` |

Limiti onesti: 6 step su siti marketing (thebrowser.company, diabrowser.com)
validano la pipeline ma non trovano vulnerabilità — la superficie d'attacco
rica (company.thebrowser.arc, l'app Arc) richiede test autenticati e più
profondi. Il prossimo moltiplicatore è `bb sync` (dati reali dall'API) e
crawl più lunghi sugli asset applicativi.

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
