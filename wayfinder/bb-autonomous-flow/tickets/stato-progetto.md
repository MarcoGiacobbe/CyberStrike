# Ticket: stato del progetto (fatti verificabili vs narrazione)

## Question

Definire cos'è lo "stato attuale" di un progetto di hunting, chi lo scrive, cosa
contiene e come si garantisce che non venga ripetuto lavoro già fatto tra una
sessione e l'altra.

Origine: esigenza utente — *"all'inizio di ogni sessione, prima di generare i
TODO, deve OBBLIGATORIAMENTE leggere lo stato attuale per non ripetere ciò che
ha fatto"*.

## Principio adottato

**Lo stato non è un file che l'agente legge: è un vincolo che il sistema impone.**

La formulazione "leggere lo stato prima dei TODO" è un'istruzione di prompt, e
un'istruzione di prompt non è una garanzia: salta se il contesto è lungo, se il
modello è debole, se l'utente chiede altro. Un requisito che deve valere SEMPRE
si impone con la meccanica.

Implementazione decisa (utente, 2026-09-24):
- **Tool bloccato meccanicamente**: l'agente NON ha `todowrite` finché non ha
  caricato lo stato. Non è un ordine, è un tool che gli manca.
- **Più regola nel prompt come rinforzo** (entrambi, non alternativi).

## Separazione fatti / narrazione (deciso)

| Cosa | Dove | Autorevolezza |
|---|---|---|
| Fase corrente, target toccati | `state.json` | Fatto |
| Vuln trovate + triage (aperta/segnalata/risolta) | `state.json` | Fatto |
| Account creati | `accounts.json` (già esiste) | Fatto |
| Evidenza crawl | `crawls/` | Evidenza grezza |
| **Note libere dell'agente** | `notes/` | **NON autorevole — mai letto come stato** |
| "Cosa ho fatto l'ultima volta" | sessioni CyberStrike | **NON duplicare nello stato** |
| Il piano TODO | sessioni CyberStrike | **NON duplicare nello stato** |

Regola chiave: **nello stato solo affermazioni che un comando sa dimostrare.**
Un LLM che scrive "ho testato l'endpoint X" senza evidenza non deve poter
inquinare lo stato. Tutto ciò che è narrazione va in `notes/`, esplicitamente
marcata non autorevole.

Perché conta: se narrazione e stato stanno insieme, al riavvio il caricamento
dello stato diventa una scansione di appunti e l'agente passa il tempo a leggere
sé stesso invece di lavorare. Lo stato deve essere **piccolo, tipizzato,
versionato, caricato sempre per intero**; i file utili **tanti, cercabili, letti
su richiesta**.

## Chi aggiorna lo stato (deciso: ibrido)

- **Push**: fase e triage — i comandi li aggiornano quando fanno qualcosa
- **Pull**: i fatti (target toccati, report presenti) — derivati dall'evidenza a
  ogni lettura

Motivo: se l'agente dimentica un aggiornamento push, lo stato pecca per DIFETTO,
non MENTE. La direzione dell'errore conta: uno stato incompleto è recuperabile,
uno stato che dichiara il falso no.

## Disallineamento (deciso: blocco)

Se lo stato dichiarato è disallineato dai fatti che il sistema conosce (es.
l'agente dichiara di aver testato X ma non c'è traccia di richieste su X):
**la sessione si blocca finché non si risincronizza il programma.**

## Da decidere

1. Forma dello stato: `state.json` con schema versionato (chi lo valida? zod?
   chi migra su cambio schema?)
2. Confine fra stato e programma: `program.json` si risincronizza e si
   sovrascrive; `state.json` NO. Come si garantisce che `bb sync` non li
   confonda (il sync oggi preserva `identity` — stesso pattern da estendere?)
3. Granularità dei "target toccati": per host, per URL, per endpoint? Un crawl
   che esplora 30 pagine su un host tocca 1 cosa o 30?
4. Cosa significa "target toccato" per un'azione fatta con `curl` o `bash` fuori
   dal crawler (che non lascia evidenza strutturata)? È il buco nero dello stato
   derivato: da decidere.
5. Staleness: dopo quanto tempo/qual cambiamento lo stato va considerato vecchio
   e il programma risincronizzato? (collegato a `lastUpdated` in `program.json`)
6. Chi promuove una nota di `notes/` a fatto verificato — solo un comando, o
   anche l'utente a mano?
---

## Verifica tecnica propedeutica (2026-09-25)

Fatti accertati con esecuzione reale, non dedotti:

**Dove può vivere lo stato.** La directory scelta
(`~/.cyberstrike/bugbounty/programs/<program>/`) **non è in un repo git** →
`Instance.worktree` cade su `/`. Verificato: `diagnose` la classifica `no-repo`,
`isSafe=true`, e i pattern coprono correttamente sia la forma relativa
(`home/marco/.../bcny-test/*`, come la manda `write.ts`) sia quella assoluta
(`/home/marco/.../bcny-test/*`, come la manda `external_directory`). Il caso
`no-repo` è **sicuro**: il pattern relativo è la discesa completa dalla radice,
quindi è ancorato e non c'è il problema "interno/esterno indistinguibili" del
caso `project-is-repo-root`.

**Meccanica del blocco todowrite.** `TodoWriteTool` (`src/tool/todo.ts:12`) fa
`ctx.ask({permission:"todowrite", patterns:["*"], always:["*"]})` — cioè è la
stessa forma `always:["*"]` del buco #2 del perimetro. Il tool **non** è
bloccabile per-agente in modo condizionale: `agent.permission` è statica
(`explore` usa `"*":"deny"` + allow). Quindi "l'agente non ha todowrite finché
non ha caricato lo stato" NON si ottiene con la permission: serve un **gate nel
tool** (`todo.ts`), non nel ruleset.

Conseguenza per il design: il blocco va implementato come **guardia in
`TodoWriteTool.execute`** che consulta lo stato di sessione (dove un flag
"stato caricato" è settato dal tool che legge lo stato). Il ruleset resta come
rinforzo, non come garanzia.

## Risposte alle domande aperte

1. **Forma dello stato**: `state.json` con **schema Zod versionato**
   (`version: 1`). Zod è già la convenzione del repo (`Todo.Info`, `Request`,
   `HackbrowserStatus.Info`). Migrazione: il loader legge `version`; se
   sconosciuta → stato dichiarato invalido → blocco (mai reinterpretare).
   Lo stato invalido non si "aggiusta a mano": si rigenera da `bb sync` +
   derivazione.

2. **Confine stato/programma**: `program.json` è **sovrascrivibile** (deriva dal
   fetch, `bb sync` lo riscrive); `state.json` è **append-only per fatti** e non
   viene mai toccato da `bb sync`. Il sync già preserva `identity` — stesso
   pattern: il sync tocca solo le chiavi che deriva, non l'intero file. Da
   rendere esplicito: `bb sync` scrive **solo** `program.json`, mai `state.json`.

3. **Granularità dei target toccati**: per **host** (non per URL). Motivo: è la
   granularità a cui lo scope è definito (gli asset in scope sono host/domini),
   è quella che rende la derivazione economica, e "1 cosa o 30" si risolve
   elencando gli host con i path toccati come dettaglio, non 30 voci piatte.
   Struttura: `targets: { "host": { firstSeen, lastSeen, evidence: [...] } }`.

4. **"Target toccato" fuori dal crawler** (curl/bash): è il buco nero. Decisione:
   **non si inventa un fatto**. Un host toccato via bash/curl NON entra in
   `state.json` (nessuna evidenza strutturata lo dimostra). Va in `notes/` come
   narrazione. Se serve tracciarlo, la strada corretta è far passare il traffico
   dal crawler (che lascia evidenza), non dedurlo. Questo mantiene la regola
   "solo affermazioni dimostrabili".

5. **Staleness**: `lastUpdated` in `program.json` + confronto con
   `last_policy_change_at` di HackerOne (già disponibile dal GraphQL, oggi
   scartato). Regola: se la policy è cambiata a monte (o `lastUpdated` > N
   giorni), lo stato è **vecchio** e `bb hunt` invita a `bb sync` prima di
   aprire la sessione. La soglia N è una costante da fissare (proposta: 7 giorni,
   più il confronto col cambio policy che è autorevole).

6. **Promozione nota → fatto**: **solo un comando**. L'utente può *chiedere* la
   promozione, ma l'atto lo esegue un comando che pretende l'evidenza. Un LLM
   (o l'utente a mano) che edita `state.json` direttamente rompe la garanzia:
   lo stato è scrivibile solo da codice che valida.

## Nota sul punto 4, che è il più delicato

Il punto 4 non è un dettaglio implementativo: è dove il design può tradire il
principio. Se "target toccato" includesse il traffico bash, lo stato tornerebbe
a contenere affermazioni non dimostrabili — cioè esattamente ciò che questo
ticket esiste per evitare. Meglio uno stato che sa meno ma non mente.

## Punto aperto residuo

Il gate todowrite richiede che il tool che **legge** lo stato setti un flag di
sessione. Chi è quel tool? Due opzioni:
- (a) un `bounty_status` tool dedicato, che l'agente DEVE chiamare;
- (b) il caricamento automatico all'apertura sessione (`bb hunt`), senza tool.

(b) è più solido (non dipende dall'agente) ma lega il gate a `bb hunt`.
(a) è più flessibile (funziona anche fuori da `bb hunt`) ma reintroduce la
dipendenza dal comportamento dell'agente. **Da decidere con l'utente.**

## Scoperta: la chiave del progetto-hunting è `session.directory`, non `project_id`

Verificato nel codice (`src/project/project.ts:187-192`, `session.sql.ts:11-33`):

Una directory **non-git** (come `~/.cyberstrike/bugbounty/programs/<p>/`) mappa
sempre sul progetto `{ id: "global", worktree: "/" }`. Conseguenza: **tutte le
sessioni di tutti i programmi condividono lo stesso `project_id = "global"`**.
`project_id` NON identifica il programma.

La chiave corretta è **`session.directory`** (colonna che esiste già): le sessioni
di un programma sono quelle con `directory = <projectDir>`. E poiché
`CoverageNote`, `RequestObservation` e `Vulnerability` hanno tutte `session_id`,
l'evidenza è già filtrabile per progetto via join su `session.directory`.

Questo chiude il punto 3 in modo economico: **i "target toccati" si derivano
dalle sessioni del progetto**, con l'asset dichiarato dai `coverage_note`
(`asset` è già generico: origin / ARN / host:port) e le vulnerabilità da
`vulnerability`. Nessuna nuova tabella, nessuna nuova contabilità: l'evidenza
c'è già, serve solo leggerla con il filtro giusto.

Nota di conseguenza sul perimetro: `worktree = "/"` significa che i pattern
relativi sono la discesa completa dalla radice (`home/marco/.cyberstrike/...`).
Verificato: `evaluate` dà `allow` sui path del progetto e `deny` su
`/home/marco/.ssh/authorized_keys` e `/etc/passwd`. Il caso `no-repo` è sicuro.

## Punto 1-bis: dove sta lo stato (DB o file?)

`state.json` su disco — è la scelta corretta per il **caricamento deterministico**
(`bb hunt` lo legge senza toccare il DB, e il perimetro lo copre). Ma i FATTI
(target, vuln) stanno nel DB. Quindi `state.json` non duplica i fatti: contiene
(a) ciò che i comandi spingono (fase, ripresa) e (b) il **riassunto derivato**
dall'ultima lettura, con timestamp di derivazione. Se i fatti derivati non
combaciano col DB, vince il DB: è la regola del disallineamento.
