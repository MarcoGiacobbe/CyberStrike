# Ticket: Orchestrator del flusso (steps 1-4)

## Question

Chi/come esegue la sequenza: (1) verifica progetto esistente → (2) verifica
cartella → (3) crea/fetch se manca, imposta workspace → (4) avvia fasi
successive. Un comando dedicato (`bb project start <handle>`), un agent
prompt di sistema dedicato, o entrambi?

## Context

Dipende da: [struttura-directory-progetto], [intercettazione-programma],
[bb-sync-fetch-hackerone]. Vincoli: scritture solo via comandi standard,
stato progetto in JSON. L'LLM orchestratore decide IL PERCORSO ma le
mutazioni passano dai comandi (sandbox-effettiva).

## Da decidere

- Forma: sub-command bb? Skill/agent prompt? Entrambi (comando = API, prompt = UX)?
- Idempotenza: ogni step ripetibile senza effetti duplicati (riavvio a metà)
- Report all'utente: cosa gli viene detto a ogni step, dove (TUI log, stato.json)
- Step 4 "fasi successive": interfaccia per fasi plugin-like o hardcoded?
