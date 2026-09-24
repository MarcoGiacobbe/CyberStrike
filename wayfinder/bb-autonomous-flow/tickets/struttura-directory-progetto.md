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
