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
