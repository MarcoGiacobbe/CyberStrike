# Ticket: Sandbox effettiva delle scritture (come farla rispettare)

## Question

Come garantire TECNICAMENTE il vincolo "nessuna scrittura fuori dalla
directory di lavoro"? Le opzioni canditate: (a) solo comandi bb scrivono
(l'LLM non ha mai bash di scrittura nel flusso bb), (b) prompt-injection
delle regole nel planner + audit, (c) wrapper/chroot delle tool bash.

## Context

Vincolo HARD utente. (a) è la più forte e la più semplice: nel flusso bb
l'agente LLM NON riceve strumenti di scrittura liberi; ogni mutazione è un
comando versionato che valida input e logga. (c) richiede hook a livello
cyberstrike (verify tool-call path). Nota: fuori dal flusso bb il TUI resta
com'è — la sandbox vale per questo flow.

## Da decidere

- (a) da sola basta? O serve anche deny-list dei path nei tool esistenti?
- Audit trail: log append-only delle scritture per ripresa sessione
- Cosa succede a read: lettura completa OK (vincolo utente lo consente)

## RESOLUTION (2026-09-24) — Opzione A

Nel flusso bug bounty l'LLM NON riceve strumenti di scrittura libera: ogni
mutazione è un comando `bb` (valida input, logga, scrive solo nella
directory progetto). Bash libero escluso dal flow. Lettura completa
consentita. Audit trail: append-only in project.json + log comandi.
