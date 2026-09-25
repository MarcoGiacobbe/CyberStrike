# Map: Bug Bounty Autonomous Flow

Tracker: local markdown (fallback per skill wayfinder — coerente col vincolo
"solo scritture nella directory di lavoro"). Tickets in `tickets/`.

## Destination

Dentro cyberstrike, un comando esplicito — `cyberstrike bb hunt <program>`
(nome deciso dall'utente, resta nel namespace `bb`) — avvia o riprende il
progetto bug bounty per quel programma: (1) verifica se esiste già un progetto,
(2) verifica/crea la cartella di lavoro standard, (3) verifica i dati del
programma (scope, regole, payout) e invita a `bb sync` se mancano o sono
vecchi, (4) apre una sessione con un agente istruito per quel programma,
perimetro di scrittura confinato al progetto e stato di hunting caricato prima
di qualsiasi pianificazione — scrivendo SOLO nella directory di lavoro, con
struttura dati standard (JSON) per progetto, niente scritture libere.

L'ideale resta un messaggio in linguaggio naturale ("voglio huntare bcny") che
porta allo stesso risultato (vedi [intercettazione-programma]); il comando è la
versione deterministica e testabile dello stesso flusso.

## Notes

- Repo: fork CyberStrike, branch `feat/bug-bounty-enhancement`
- Primitive esistenti: comandi `bb` (CLI), launcher/tool hackbrowser, bbmail,
  accounts autonomi, identity injection, prompt Bug Bounty
- Agenti già pronti da riusare: `web-application` (+ `cloud-security`,
  `internal-network`, `mobile-application`) con toolset completo e skill WSTG;
  tool di reportistica: `generate-report`, `triage-vulnerability`, `vrt-check`,
  `scope-check`
- Vincolo HARD (utente): agente senza potere di SCRITTURA fuori dalla directory
  di lavoro; lettura libera ovunque (read è già allow); il vincolo vale anche
  per bash
- Vincolo HARD (utente): informazioni gestite a livello DB/JSON per progetto
- Vincolo HARD (utente): il vincolo di scrittura va imposto MECCANICAMENTE, non
  con istruzioni nel prompt — le regole nel prompt sono rinforzo, non garanzia
- LLM orchestratore: OpenRouter attualmente senza crediti (402) — serve per E2E

## Decisions so far

- [Verifica E2E capacità attuali](tickets/verifica-e2e-capacita.md): TUI linguaggio naturale esiste; il flow autonomo progetto NON esiste — primitive sì, orchestrazione no
- [Research: scopes senza auth](tickets/research-scopes-senza-auth.md): API H1 richiede auth SEMPRE (401 su tutti gli endpoint senza token) — sync via API = token obbligatorio; fallback public = scrape pagina + warning
- [Struttura directory progetto](tickets/struttura-directory-progetto.md): OPZIONE 1A — root ~/bugbounty/<programma>/ con project/program/accounts.json + crawls//reports/; scritture solo via comandi bb
- [Intercettazione programma](tickets/intercettazione-programma.md): OPZIONE A — LLM riconosce intenzione, conferma HITL su programma nuovo, esecuzione solo via comandi bb
- [Sandbox scritture](tickets/sandbox-scritture.md): OPZIONE A — nel flow bb l'LLM non ha strumenti di scrittura libera; tutto via comandi bb; lettura completa ok
- [Credenziali H1 sync](tickets/credenziali-h1-sync.md): RISOLTO (2026-09-24) — l'identifier dell'API è lo username H1, non il valore del token (`markjacob9:<token>` → HTTP 200). `bb connect` ridotto a 2 passi, auto-retry con username, token mascherato in `whoami`. Commit `7fa7f8fee`
- [Identity da policy](tickets/identity-da-policy.md): APERTO (2026-09-24) — `resolveIdentity()` pronta e verificata ma `cfg.identity` non viene mai popolato: `bb sync` lo conserva soltanto. Serve derivare header/UA dalle direttive del programma. Caso di test utile: programma HackerOne `security` (chiede header custom), NON bcny (non lo chiede)
- [Help comandi bb](tickets/help-comandi-bb.md): APERTO (2026-09-24) — `cyberstrike bb --help` non elenca le azioni (connect/sync/mail/accounts/…); le descrizioni non riflettono il comportamento reale di `bb sync` (limite 100 scope senza paginazione, niente known issues/hacktivity, policy troncata a 500 char nel JSON). Difetti adiacenti annotati: paginazione assente, wildcard non convertiti in pattern
- [Sandbox](tickets/sandbox-scritture-perimetro.md): FASE 1 FATTA (2026-09-25, commit `84d3d4a34`) — gate implementato, 5 buchi chiusi dopo verifica avversariale indipendente. **V8 ha aggiunto: `buildProjectRuleset`/`diagnose` NON hanno chiamanti di produzione — il perimetro è una difesa di libreria finché `bb hunt` non lo istanzia.** Restano aperti: V1/V2/V3/V6, la decisione su `always:["*"]` a monte, e i buchi P1–P7 di V8 (matching per uguaglianza, guardia B14 solo su `rel===""`, symlink non dereferenziati)
- [Stato del progetto](tickets/stato-progetto.md): **IN CORSO — la verifica V8 ha corretto il verdetto** (2026-09-25). Implementazione `d861d3267`; verifica V7 (13 buchi B1–B13) e fix `66b606d68`; verifica V8 dei fix: 12 cadute (P1–P12) + **il perimetro non è cablato in produzione**. I fix chiudono il canale interattivo ma il ticket **NON è chiuso**: vedi [verifica-fix-v8.md](tickets/verifica-fix-v8.md) per l'ordine dei fix in 6 passi. `bounty-state.ts` (stato versionato, scrittura atomica), `bounty_status` (tool), gate `todowrite` in due forme (il tool manca / il gate lancia), `BountyState.loaded` per (sessione, directory).
- [Agente bounty + messaggio iniziale](tickets/agente-bounty-prompt-iniziale.md): APERTO (2026-09-24) — NON inventare l'agente: `web-application` esiste già con toolset completo (bash/hackbrowser/webfetch/report_vulnerability/triage_vulnerability/scope_check/methodology_status + skill WSTG). Manca l'agente bounty che nasce istruito per il programma specifico. Il messaggio deve dichiarare esplicitamente i dati che NON ha (known issues, identity) invece di fingere
- [Comando `bb hunt`](tickets/hunt-comando-entry-point.md): APERTO (2026-09-24) — entry point: `cyberstrike bb hunt <program>` (nome scelto dall'utente, resta nel namespace bb). Bootstrap progetto → verifica program.json → carica stato → sessione con agente bounty + perimetro → messaggio con contesto. Idempotente: rilanciato a metà riprende senza duplicare

## Dipendenze fra i ticket

Ordine di implementazione suggerito:

```
sandbox-scritture-perimetro   ← PREREQUISITO (senza perimetro, hunt non è sicuro)
        ↓
stato-progetto                ← cosa legge il comando + blocco todowrite
        ↓
agente-bounty-prompt-iniziale ← agente + messaggio (dipende dai dati dello stato)
        ↓
hunt-comando-entry-point      ← unisce tutto, ed è l'entry point della MAP
```

Ticket indipendenti (nessuna dipendenza, si possono fare in qualsiasi momento):
`identity-da-policy`, `help-comandi-bb`, e i difetti annotati in
`help-comandi-bb` (paginazione GraphQL a 100, wildcard non convertiti).

## Verifica — arretrati (NON verificato)

Regola: **ogni verifica di sostanza passa da un subagent indipendente**, con
mandato avversariale (cercare il difetto, non confermare il caso felice). La
verifica dell'autore non conta come verifica. Un ticket non è "fatto" finché
questo elenco non è vuoto per le sue voci.

| # | Cosa manca | Su cosa | Perché non ora |
|---|---|---|---|
| V1 | E2E con `bb hunt` reale (catena comando → sessione → agente → perimetro) | sandbox-scritture-perimetro, stato-progetto, hunt-comando-entry-point | `bb hunt` non esiste ancora: nessun test attraversa la catena fino in fondo |
| V2 | Attrito reale di `bash` in un hunting vero (quante conferme si ricevono, se il flusso è usabile) | sandbox-scritture-perimetro | si misura usandolo su un target, non testandolo |
| V3 | Modifica `always: ["*"]` in `write.ts`/`edit.ts` — la difesa è a valle (`PermissionNext.ask`), la causa è a monte | sandbox-scritture-perimetro (buco #2) | tocca il comportamento di TUTTI gli agenti, non solo del perimetro: serve decisione |
| V7 | Verifica avversariale stato+gate+`always` — **FATTA (2026-09-25)**: 13 buchi (task-0 B1–B13) + 4 sulla difesa `always` (V8.1–V8.4). I più gravi: B1 lo stato invalido NON blocca sul percorso default (refresh rigenera `idle` cancellando la fase), V8.1 escape via bash con un click "sempre", V8.2 seed `approved` batte il deny. Fix A1–A13 **APPLICATI** (commit `66b606d68`) + B14 (nuovo, GRAVE: `dir === worktree` → pattern `"/*"` → allow su ogni path assoluto). Ticket [verifica-stato-gate-always.md](tickets/verifica-stato-gate-always.md) | stato-progetto, sandbox-scritture-perimetro | — |
| V8 | Verifica avversariale dei FIX (`66b606d68`) — **FATTA (2026-09-25)**: 3 subagent separati, 12 cadute + il fatto che riordina le priorità. Dettagli in [verifica-fix-v8.md](tickets/verifica-fix-v8.md). **E1 (decisivo): `buildProjectRuleset` e `diagnose` NON hanno chiamanti di produzione** — il perimetro è una difesa di libreria, non cablata: impatto pratico nullo finché `bb hunt` non lo istanzia (e se il confine verrà espresso con `ask` invece di `deny`, `isPerimeter()` non lo riconoscerà più e tutti i filtri saltano in silenzio → serve un marcatore esplicito di sessione). Causa comune: confronti per **uguaglianza letterale** dove serve una **proprietà**. Perimetro: P1 `coversEverything` letterale (`?????*`, `*/*`, `/etc/*` battono il deny); P2 permission con jolly (`bash*`/`edit*`/`*` svuotano il confine, raggiungibili da config reale); P3 ogni click "sempre" su bash è un no-op permanente (attrito dichiarato "inutilizzabile in pratica", peggiorato); P4 l'override `{question:'allow'}` viene ucciso (serve allowlist delle permission filtrabili). Percorsi: P5 la guardia B14 copre solo `rel===""`, non la salita (`dir=/tmp` → `../*` → `edit('../../etc/passwd')=allow`); P6 symlink non dereferenziati (`state.json` scritto FUORI); P7 `root()` non canonizzato. Stato: P8 **symlink dangling riapre B1** (`existsSync` invece di `lstat`); P9 `read()` non valida `info.directory===dir` (`mv acme acme-2026` → leggere in A riscrive B e cancella in silenzio la fase dichiarata in B); P10 iniezione di righe false nei campi DICHIARATI (basta il nome della directory); P11 gate armato in anticipo + sbloccato da una sottodirectory; P12 `divergences()` non rileva scomposizioni false/evidenza inesistente. **Chiuso e verificato**: il canale interattivo non si svuota con un click, B6 per path, B8, contratto "il tool MANCA", stato invalido che blocca (tranne P8), sanificazione `hostOf`. **Aperta** — fix da approvare in 6 passi (ordine nel ticket). | stato-progetto, sandbox-scritture-perimetro | fatta con 3 subagent indipendenti |
| V9 | Verifica avversariale dei fix V8 (`9d7afe936` + `260e03516`) — **IN CORSO (2026-09-25)**: 3 subagent con mandati separati — (a) marcatore `boundary` (si può forgiare? il round-trip su DB lo conserva? `sameArea` bidirezionale riconosce aree che non dovrebbe?), (b) stato/percorsi (`canonical` e il suo fallback, `presence` su FIFO/directory/chmod 000, **regressione su un progetto reale `bcny`**), (c) il nuovo `always` esatto (un comando opaco che scrive fuori progetto può diventare permanente con un click?). I fix sono dell'autore: non contano come verifica. | stato-progetto, sandbox-scritture-perimetro | — |
| V4 | `Paginazione a 100` in `bb sync` e wildcard non convertiti in pattern | help-comandi-bb | difetti annotati, non ancora ticket autonomi |
| V5 | `security` come caso di test per `resolveIdentity()` (programma che CHIEDE header custom) | identity-da-policy | serve il fetch di un programma reale che richieda header |
| V6 | Contenimento a livello kernel (il perimetro è un gate applicativo, non un sandbox del SO) | sandbox-scritture-perimetro | limite dichiarato per scelta di design |

## Not yet specified

- Step 4: fasi successive del flusso (hunting guidato, report, scheduling,
  ripresa sessioni) — da definire in dettaglio con l'utente
- Multi-programma: registry dei progetti, switch, convivenza
- Cosa succede agli account pending quando l'utente non approva (TTL? reminder?)
- Promozione automatica di una nota di `notes/` a fatto verificato (vedi
  [stato-progetto], punto 6)
- "Target toccato" per azioni fuori dal crawler (curl/bash): buco nero dello
  stato derivato (vedi [stato-progetto], punto 4)

## Out of scope

- Piattaforme ≠ HackerOne per il fetch automatico (Bugcrowd/Intigriti: dopo)
- UI grafica dedicata oltre al TUI esistente
- Modifica a monte del core cyberstrike non necessaria al flusso
