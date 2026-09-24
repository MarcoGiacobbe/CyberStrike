# Ticket: agente bounty + messaggio iniziale di sessione

## Question

Definire l'agente dedicato all'hunting su programma (toolset + prompt) e il
messaggio con cui `bb hunt` apre la sessione: quali informazioni del programma
ci finiscono, in che forma, e con quali placeholder ancora aperti.

Attenzione: NON va inventato un agente da zero — il toolset per l'hunting web
esiste già ed è cablato.

## Context — cosa esiste già

Agenti esistenti (`src/agent/agent.ts`):
- `web-application` — descrizione: *"Web application security specialist. OWASP
  Top 10, WSTG methodology, API security testing."* mode `subagent`, skills
  `wstg-recon-config`, `wstg-auth-session`, `wstg-injection`, `wstg-logic-client-api`,
  permessi: `bash`, `hackbrowser`, `read`, `glob`, `grep`, `webfetch`, `websearch`,
  `report_vulnerability`, `triage_vulnerability`, `add_intel`, `update_vrt_check`,
  `methodology_status`, `scope_check`, `ensure_tools`, `attack_script` (tutti allow)
- altri: `cloud-security`, `internal-network`, `mobile-application`,
  `normalize-request`, `proxy-agent`, `proxy-tester-*` (idor/authz/injection/…)

Tool di reportistica già presenti: `generate-report`, `triage-vulnerability`,
`vrt-check`, `scope-check`, `report_vulnerability`, `methodology-status`.

Prompt: `src/agent/prompt/methodology/common-prompt.txt` + `web-application.txt`;
overlay bug bounty in `packages/hackbrowser/src/prompt/bugbounty.txt` (15.624
byte) — oggi caricato dal NAVIGATOR (`navigator.ts:16`), non iniettato nella
sessione dell'agente.

Placeholder dinamici già previsti (restano placeholder finché il fetch non li
popola): `{program_name}`, `{platform}`, `{scope_in}`, `{scope_out}`,
`{known_issues}`, `{payout_focus}`.

## Contenuto atteso del messaggio iniziale

- nome programma, piattaforma, URL
- scope in / scope out (con nota sul limite: `bb sync` prende max 100 asset,
  niente paginazione; wildcard non convertiti in pattern)
- payout (per tier + per asset)
- regole + esclusioni (`EXCLUSION <categoria>: …` da `declarative_policy`)
- **header/identità richiesti dal programma** — dipende da
  [identity-da-policy]: se non implementato, il messaggio deve dirlo
  esplicitamente invece di tacere
- known issues: **oggi NON disponibili** (la query GraphQL non le chiede) →
  il messaggio non deve fingere di averle
- fase corrente + cosa resta (da [stato-progetto])
- toolset disponibile e vincolo di scrittura

## Da decidere

1. Agente nuovo `bounty` che estende `web-application`, o riuso diretto di
   `web-application` con prompt iniettato per sessione? (il primo è più pulito
   ma duplica; il secondo non permette un prompt diverso per agente)
2. Prompt: `bugbounty.txt` va iniettato come messaggio utente iniziale, come
   system prompt dell'agente, o entrambi? Oggi il file esiste ma arriva solo al
   navigator.
3. Formato del messaggio: markdown compatto vs JSON strutturato — dipende da
   quanto il modello deve "leggere" vs "usare" i dati
4. Chi fa il rendering dei placeholder, e cosa succede se un dato manca
   (sezione omessa vs stringa "unknown")? Silenzio vs dichiarazione esplicita.
5. Il messaggio deve essere visibile all'utente nella TUI (trasparenza su cosa
   è stato detto all'agente) o è contesto nascosto?