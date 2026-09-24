# Ticket: Struttura directory di progetto e suo standard

## Question

Qual è la struttura standard della directory di progetto per-programma (nome
root, dove sta il JSON del progetto, degli account, delle sessioni di crawl,
dei report), e chi la crea (orchestrator vs comando `bb project init`)?

## Context

Vincolo HARD utente: l'agente scrive SOLO qui, con standard di scrittura —
non liberamente. CyberStrike già gestisce info a livello DB/sessione; questo
livello è per-progetto. Oggi i dati esistono sparsi:
`~/.cyberstrike/bugbounty/<name>.json` (config), `<name>.accounts.json`
(account), niente sessioni/report per progetto.

## Da decidere

- Root: `~/bugbounty/<program>/`? `./<program>/` (cwd utente)? Sotto `~/.cyberstrike/`?
- Cosa è "il progetto": program.json + accounts.json + crawls/ + reports/ + state.json?
- Standard di scrittura: solo tool (`bb` / orchestrator) scrivono, mai l'LLM con bash?
- Compatibilità: migrare quanto già in `~/.cyberstrike/bugbounty/` o linkare?

## RESOLUTION (2026-09-24) — Opzione 1A

Root `~/bugbounty/<programma>/` (fuori da ~/.cyberstrike/ che resta
infrastruttura: credenziali connect, worker bin). Struttura standard:

    ~/bugbounty/<programma>/
    ├── project.json      stato progetto (fasi, date, ripresa)
    ├── program.json      scope, regole, payout, identity (dal fetch)
    ├── accounts.json     account gestiti
    ├── crawls/           risultati sessioni crawl
    └── reports/          segnalazioni

Regola scritture: l'LLM non scrive mai liberamente — ogni mutazione passa
dai comandi `bb` che validano e loggano.
