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

### Implementato il 2026-09-28 (review avversariale `deleg_49381b00`)

Fino al 28/09 la riga 64 sopra era **decisa ma non implementata**: la divergenza
veniva mostrata come avviso e la sessione restava sbloccata. Misurato, non
dedotto.

**Difetto riprodotto** (`test/tool/bounty-divergence-blocks.test.ts`):
`readChecked()` chiama `markLoaded()` a `bounty-status.ts:131` **prima** che
`divergences()` venga valutato alla riga 62. Quindi uno stato che dichiara 3
target con zero evidenza sbloccava `todowrite`:

```
Expected: false
Received: true        <- BountyState.loaded(sid) su stato che mente
```

A `HEAD` il test è rosso su quella riga; col fix è verde. Il test è la prova,
non parte del fix.

**Fix** — un blocco meccanico, non un messaggio:
- `BountyState`: nuovo `blockedFlag` in `Instance.state` (per-sessione,
  azzerato al riavvio) con `markBlocked/blocked/isBlocked/clearBlocked`.
  `markBlocked` rimuove anche il flag `loaded`: uno `loaded` residuo da una
  lettura precedente non deve tenere aperto il gate.
- `bounty_status`: in `refresh: false`, divergenze > 0 ⇒ `markBlocked`.
  Con `refresh: true` non può accadere: `load()` ri-deriva e riscrive.
- `load()` chiama `clearBlocked`: ri-derivare risolve per costruzione, altrimenti
  il blocco sarebbe un vicolo cieco.
- `todo.ts`: il gate consulta `blocked` **prima** di `loaded`. Caricare non
  basta: conta stato caricato *ed* coerente con i fatti.

**Verificato anche** (`bounty-divergence-unblock.test.ts`): il blocco si
riapre — `refresh: true` → 0 divergenze → sbloccato → `todowrite` torna a
funzionare; ed è per-sessione (una sessione nuova non eredita il blocco, ma
neanche risulta sbloccata: deve caricare a sua volta).

**Perché `refresh: false` è il caso bloccante e non `refresh: true`**: con
`refresh: true` `load()` ri-deriva dai fatti e riscrive, quindi la divergenza non
sopravvive per costruzione — non è una scelta di comodità, è l'unico punto in cui
uno stato fermo può mentire.

## Difetti ANCORA APERTI (stessa review, non affrontati)

**P1 — una coverage note arbitraria diventa un fatto** (`coverage-note.ts:6–21`).
Il tool accetta asset e nota forniti dall'agente senza richiedere un request
ID, un'observation o altra prova tecnica; `derive()` considera la sola riga DB
come prova sufficiente. Riprodotto dalla review: nota dichiarata priva di
observation, `request_id` assente, accettata; ne è derivato il target
`never-contacted.invalid`. **Non risolto**: richiede una decisione su quale
evidenza sia minima accettabile.

**P1 — prova falsa nei campi `sessions`/`lastSeen` non rilevata**
(`bounty-state.ts:491–525`): `divergences()` confronta il *numero* delle
sessioni e `firstSeen`, ma non gli ID effettivi né `lastSeen`. Misurato dalla
review con `Info.safeParse(...).success === true` e `divergences() === []` a
parità di host e conteggio, con ID inventato e data 1999. **Non risolto**.

**Nota**: la review non ha verificato l'accettazione di quello stato tramite
`bounty_status` in un setup DB separato; il gap di confronto è misurato nel
codice, il percorso completo no. Da rifare prima di chiudere.

**E1 è chiuso**: `bb.ts:702–715` chiama `diagnose()`, verifica `isSafe()` e
costruisce le regole; `bb hunt bcny --dry-run` reale → `regole: 9` con
`deny edit *`. La MAP era stale su questo punto.

**Gap di inizializzazione**: `bb hunt` legge lo stato (`bb.ts:691–695`) ma non
chiama `create/load/refresh`; `create()` non ha chiamanti di produzione
individuati, e `setPhase()`/`regenerate()` risultano senza chiamanti. Lo stato
iniziale nasce solo se l'agente chiama `bounty_status`; il dry-run reale mostra
`nessuno stato (progetto nuovo)`. Nessun `state.json` esiste oggi sui programmi
reali. **Non risolto** — è il prossimo ostacolo alla chiusura.

## Gap di inizializzazione — CHIUSO il 2026-09-28

`bb hunt` validava il programma e costruiva il perimetro, ma **leggeva** lo
stato e non lo creava mai. `BountyState.create()`, `setPhase()` e `regenerate()`
non avevano **nessun caller** in tutto il codice di produzione, e sui programmi
reali non esisteva alcun `state.json`. Misurato prima del fix: `ls
~/.cyberstrike/bugbounty/programs/*/state.json` → nessuno.

Il difetto non è cosmetico: `isHuntingDir()` è il gate che distingue una
directory di hunting. Senza stato il gate non ha nulla su cui vigilare, e la
prima sessione parte senza confine. Peggio: lo stato nasceva solo se **l'agente**
decideva di chiamare `bounty_status` — il confine dipendeva dalla cooperazione
di chi doveva essere sorvegliato.

**Fix** (`bb.ts`, passo 3): se `state.json` non esiste e non è `--dry-run`, si
inizializza. Il discriminante è `BountyState.fileExists()`, non
`instanceof Unreadable`: quell'errore copre due casi diversi ("non c'è ancora
nessuno stato" = progetto nuovo, e "c'è ma è corrotto"), quindi il **tipo**
dell'errore non basta. Per "c'è ma è illeggibile" l'errore viene propagato
(regola B1) e il file non viene sovrascritto.

`exists()` esisteva già ma fa un'altra domanda ("è leggibile", e per un file
corrotto torna `false`): usarlo per questa decisione avrebbe fatto esattamente
ciò che il suo commento vieta. Per questo `fileExists()` è un nome nuovo, non un
alias.

**Misurato end-to-end** (non col test isolato, che da solo non esercita `bb hunt`):

| prova | esito |
|---|---|
| `bb hunt probe` reale | `state.json` creato, mode 600, `phase: idle`, `targets: 0`, `derivedAt: null` |
| `--dry-run` | non scrive nulla |
| 2° avvio con `phase: reporting`, 1 target | preservati — il lavoro dichiarato non si azzera |
| `state.json` corrotto | `rc=1`, file **non** sovrascritto, errore propagato |

typecheck 11/11; suite 956 test 0 fail (5 run consecutivi).

## Confronto incompleto dei campi — CHIUSO il 2026-09-28

`divergences()` confrontava `sessions` per **lunghezza** e `lastSeen` **non lo
confrontava affatto**. Misurato prima del fix, tutte e tre le righe vuote = nessuna
divergenza, cioè "conforme":

| stato dichiarato | esito a `HEAD` |
|---|---|
| `sessions: ["ses_INVENTATO"]` al posto di `["ses_reale"]` | `[]` — conforme |
| `lastSeen: 1999-01-01` | `[]` — conforme |
| stesse sessioni in ordine inverso | `[]` — conforme, e giusto |

Il commento nel codice (riga ~510) prometteva già il contrario — *"un `sessions: 40`
con id inesistenti, o un `firstSeen` che precede ogni evidenza, è altrettanto
falso"* — quindi era un difetto documentato e tradito, non un'omissione.

**Fix**: gli ID si confrontano come **insieme**, non come sequenza (il fatto è
"quale sessione ha toccato il target", non "in che ordine è arrivata"), e
`lastSeen` entra nel confronto. I confronti restano **indipendenti**: la prima
versione accoppiava i controlli con `continue` e nascondeva un `firstSeen` falso
dietro l'errore sulle sessioni. Me l'ha segnalato il test **P12**, preesistente,
che per questo non ho toccato — ho corretto il mio codice invece che il test.

Test `divergence-fields` (5): rosso a `HEAD` (2 fail), verde col fix. Include il
controllo che l'ordine **non** è un fatto e che uno stato perfettamente conforme
non produce divergenze.

typecheck 11/11; suite 961 test 0 fail.

## Coverage note — LAVORO FUTURO (non è priorità, utente 2026-09-28)

**Difetto misurato**: una nota che dichiara esplicitamente l'assenza di prove
viene accettata e il suo host finisce in "Targets touched" come fatto. La prova
non è simulata, è passata dal tool reale: `note: "NON ho eseguito alcun test.
Nessuna prova."` → `derive()` restituisce `mai-toccato.example`, `COUNT = 1`.
Aggiungere un `request_id` non cambia nulla: è una stringa dichiarata
dall'agente come la nota, quindi non è prova.

**Perché non è chiuso con la scelta "respingi senza prova"**: l'utente l'ha
scelta, ma verificando l'impianto la prova tecnica **non esiste come dato**.
`Request.add` ha un solo caller di produzione ed è `session.ingest`, una route
che accetta un messaggio da chi si connette; `session.request` e
`session.observations` sono di sola lettura. Non c'è un canale che registri il
traffico reale del proxy. Costruire il gate su `request_id` oggi produrrebbe
rigore solo apparente: l'agente riempierebbe anche quel campo, con lo stesso
difetto di adesso e un'etichetta che promette il contrario.

**Il lavoro futuro è in due tempi**: (1) un canale che registri le richieste
reali, scritto dal proxy e non da chi dichiara; (2) il gate che lega la nota a
quella richiesta e respinge senza riscontro. Fino ad allora il difetto resta
aperto e va ricordato ogni volta che si legge "Targets touched".


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

## Fallimento fantasma NON isolato (2026-09-28)

In due esecuzioni non consecutive della suite è comparso `1 fail` senza che il
test fallito fosse riportato nel `grep`. Dopo il primo episodio: 9 run consecutivi
puliti; dopo il secondo: 8 run consecutivi puliti. Ogni file di test bounty è
verde **sia da solo sia in gruppo**, quindi l'ipotesi iniziale (sette file che
impostano `process.env.CYBERSTRIKE_HOME` a un `mkdtemp` diverso) **non è
confermata**: `BountyState.root()` legge la variabile a runtime, non all'import.

Non ho la riproduzione, quindi **non attribuisco una causa**. Se ricompare, la
traccia utile è il nome del test fallito in quella esecuzione, che questa volta
non ho catturato. Da non confondere con la divergenza su `sessions`/`lastSeen`,
che invece è misurata e chiusa (`7b5fa1581`) e si riproduce in modo deterministico.

## Stato del ticket: CHIUSO con lavoro futuro

Chiusi in questa sessione, tutti con controprova a `HEAD`:

1. **Divergenza bloccante** (`8cdce8a2a`) — era un avviso, ora blocca la sessione.
2. **Inizializzazione** (`83f9ca7d4`) — `bb hunt` non creava lo stato; `create()`,
   `setPhase()` e `regenerate()` non avevano caller.
3. **Confronto completo dei campi** (`7b5fa1581`) — `sessions` confrontato per
   lunghezza, `lastSeen` non confrontato.

Rimane **fuori ticket, non è priorità** (deciso dall'utente): la coverage note
senza prova tecnica diventa un target toccato. Il difetto è misurato e
documentato, ma non è chiudibile finché non esiste il canale che registra il
traffico reale. Va ricordato a ogni lettura di "Targets touched".

typecheck 11/11; suite 961 test 0 fail.

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

## Punto aperto residuo — DECISO il 2026-09-28: resta (a)

Il gate todowrite richiede che il tool che **legge** lo stato setti un flag di
sessione. Due opzioni:
- (a) un `bounty_status` tool dedicato, che l'agente DEVE chiamare;
- (b) il caricamento automatico all'apertura sessione (`bb hunt`), senza tool.

**Decisa (a)**: l'agente deve chiamare `bounty_status`, e resta bloccato finché
non lo fa. Motivo: è già implementato e testato, e funziona anche quando la
sessione non parte da `bb hunt` — (b) legherebbe il gate a un solo punto di
ingresso. Il costo accettato è che l'agente debba fare una chiamata in più; il
beneficio è che il blocco non dipende dal percorso con cui la sessione è nata.

Nota: questa scelta è coerente con la scelta già fatta sull'inizializzazione —
`bb hunt` crea lo stato (il confine esiste), l'agente deve caricarlo (per
poter pianificare). Sono due cose distinte: la prima riguarda l'esistenza del
dato, la seconda l'uso che se ne fa.


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
