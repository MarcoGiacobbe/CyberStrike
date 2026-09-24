# Ticket: Intercettazione del programma nel linguaggio naturale

## Question

Come l'agente TUI, da un messaggio naturale ("voglio huntare bcny"),
identifica il programma e passa in modalità progetto? Matching diretto
handle → registry, oppure il planner LLM decide e chiama i comandi `bb`?

## Context

`cyberstrike run "..."` e il TUI esistono. L'LLM orchestratore ha tool bash —
ma il vincolo sandbox dice: l'LLM non scrive liberamente; i comandi `bb` sono
i punti di scrittura standardizzati. La decisione influenza tutti i ticket
successivi (chi orchestra: LLM con tool vincolati vs entrypoint dedicato).

## Da decidere

- Rilevamento: regex handle noto nel messaggio vs intenzione LLM (con conferma)
- Cosa passa all'orchestrator: solo il nome? anche il "piano" dichiarato dall'utente?
- Conferma utente prima di creare un progetto nuovo (HITL) o via libera (AFK)?

## RESOLUTION (2026-09-24) — Opzione A

LLM riconosce l'intenzione dal messaggio naturale → conferma all'utente se
il programma è NUOVO (HITL sulla creazione) → poi l'esecuzione passa SOLO
per comandi `bb` (il cervello decide, le mani sono i comandi). Handle già
noti nel registry: nessuna conferma extra, ripresa diretta.
