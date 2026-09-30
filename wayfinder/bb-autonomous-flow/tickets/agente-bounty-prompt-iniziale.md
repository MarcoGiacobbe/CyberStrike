# Ticket: agente bounty + messaggio iniziale di sessione

## Stato: FASE 1 IMPLEMENTATA E MISURATA (2026-09-29)

## Ritrovamento che cambia la fase 3 (2026-09-29)

**Il file `policy.md` completo esiste GIA' su disco.** `bb sync` lo scrive:
`sync.ts:176` → `writeFileSync(\`${dir}/${handle}.policy.md\`, policy)`.

Misurato sulla macchina dell'utente:
```
bcny.policy.md        12.702 byte
bookingcom.policy.md  12.966 byte
security.policy.md     7.226 byte
```

Conclusione: la fase 3 NON deve generare il file. Deve **indirizzarlo** —
il messaggio iniziale e l'`AGENTS.md` dicono all'agente che il testo
integrale della policy è quel file, invece dei 500 caratteri troncati. Il
lavoro reale della fase 3 è `scope.md` + payout per-asset + il collegamento.

## Fase 1 — fatta e controprovata

Tre difetti, tutti misurati a `HEAD` prima del fix:

1. **`bb hunt` non passava la directory del programma al TUI.**
   `bb.ts:791` costruiva `tuiArgs` senza `--project`. Il TUI fa
   `process.chdir(args.project ? resolve(...) : process.cwd())`
   (`tui/thread.ts:95`), quindi l'agente partiva dalla cartella del terminale
   e `AGENTS.md` veniva risolto sul posto sbagliato: l'agente riceveva le
   istruzioni del progetto da cui l'utente aveva lanciato il comando.
   FIX: `--project <directory del programma>` nei tuiArgs.

2. **Il messaggio all'agente prometteva un `program.json` che non esiste.**
   `hunt-context.ts` diceva "Non c'e' un `program.json`: lo scope e le regole
   qui sotto non ci sono". `program.json` non compare in nessun punto di
   `src/`: il file reale e' `<handle>.json` nella root bug bounty
   (`bb.ts:664-671`). Il messaggio negava dati che l'agente aveva sotto gli
   occhi e promise un file inesistente.
   FIX: riscritto — dice che i dati non sono in disco e che cosa fare.

3. **Una directory vuota creata a ogni avvio.** `bb.ts:693` faceva
   `mkdirSync(path.join(directory, "program"))`. Unica occorrenza di quel
   nome in tutto `src/`: la riga stessa. Nessuno la leggeva.
   FIX: rimossa.

### Test e controprova

`test/cli/bb-hunt-directory.test.ts`, 4 test.

```
col fix:   4 pass, 0 fail
a HEAD:    2 pass, 2 fail   (i due difetti reali)
typecheck: 11/11
```

**Due test sono dichiarati non-regressione** e non provano i difetti:
- "il TUI accetta un argomento di progetto": a `HEAD` e' gia' verde, il flag
  esisteva gia' nel TUI. Serve a impedire che il fix passi un flag inventato.
- "la directory creata non contiene `program`": il dry-run gia' evitava la
  mkdir. Dice cosa non deve ricomparire, non che il difetto fosse riprodotto.

### Due errori miei durante il lavoro, dichiarati

- Il test ispezionava il sorgente con una regex; l'apostrofo di `e'` nei
  commenti italiani la faceva agganciare. Riscritto per **chiamare**
  `HuntContext.message()`: si misura il testo che l'agente riceve davvero.
- La finestra di 8 righe attorno a `tuiArgs` si fermava a `--agent` e non
  arrivava a `--project`: il test era rosso **col fix gia' applicato**, cioe'
  misurava la mia ipotesi sulla formattazione. Ora legge l'array intero.

### Difetto scoperto, NON ancora chiuso

`test/tool/bounty-state-initialization.test.ts:34-37` costruisce a mano
`program/program.json`, cioe' lo stesso file che non esiste in produzione. Il
test passa ma la sua premessa e' falsa: e' un test che non descrive il
comportamento reale. Da riscrivere quando si affronta lo stato.

## Storico del difetto (rimosso: era STALE)

Il ticket originale lamentava che il messaggio iniziale non mostrasse
piattaforma, URL del programma e regole custom. Quei dati **esistono gia'**
in `sync.ts` e in `HuntContext.message`. Cio' che manca davvero e' altro, e
e' quello scritto sopra.

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