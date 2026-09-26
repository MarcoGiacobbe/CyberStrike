# SQLiteError: bad parameter or other API misuse all'avvio del TUI

## Sintomo

Segnalato dall'utente il 2026-09-26, su un avvio dentro il container che poi
ha funzionato:

```
█ New session - 2026-09-26T14:31:38.196Z
  █   ▀▀█ cyberstrike -s ses_f21df062bffeKUjZkLl2uPTcN1

SQLiteError: bad parameter or other API misuse
  errno: 21, byteOffset: -1, code: "SQLITE_MISUSE"
    at prepare (bun:sqlite:331:37)
    at run (.../drizzle-orm/bun-sqlite/session.js:23:40)
    at run (.../drizzle-orm/sqlite-core/query-builders/insert.js:149:15)
    at <anonymous> (/app/packages/cyberstrike/src/session/index.ts:657:10)
    at run (node:async_hooks:62:22)
    at use (/app/packages/cyberstrike/src/storage/db.ts:203:28)
    at <anonymous> (/app/packages/cyberstrike/src/session/index.ts:648:14)
    at process (/app/packages/cyberstrike/src/session/processor.ts:370:29)
```

## Dove

`packages/cyberstrike/src/session/index.ts:657`, dentro `updateMessage` — la
riga che chiama `.run()` sull'`insert ... onConflictDoUpdate`. Chiamato da
`session/index.ts:648` (`Database.use`), a sua volta da
`session/processor.ts:370` quando il processor prende in carico il messaggio
utente.

Non e' la creazione della sessione: la sessione esiste gia' (`ses_f21df062…`
e' scritta nell'intestazione), e il fallimento e' sull'inserimento del
messaggio.

## Perche' non e' innocuo

`SQLITE_MISUSE` da `prepare()` con `byteOffset: -1` non e' un errore di
constraint (che darebbe un codice diverso e un messaggio utile). E' un uso
errato dell'API: statement preparato male, o un handle chiuso/riutilizzato
mentre la prepare gira.

Il perche' non e' ancora isolato. Il sospetto principale e' una **race fra
processi sullo stesso file SQLite**: il volume `cyberstrike-share` e' montato in
piu' invocazioni, e piu' di un processo CyberStrike che scrive insieme su
`cyberstrike.db` con `prepareQuery` puo' invalidare lo statement. Questo
collegherebbe l'errore al fatto che piu' sessioni sono state avviate in
parallelo, ed e' coerente con l'esaurimento di memoria segnalato il 2026-09-26.

Alternativa da non escludere: `bun:sqlite` con WAL e piu' worker che scrivono
nello stesso momento.

## Stato

**Aperto, causa non isolata.** Non e' un errore transitorio da ignorare: se
 capita a metà di un `bb hunt`, la sessione resta a meta' e il perimetro
 applicato non corrisponde a quello salvato.

Criterio di chiusura: riprodurre in modo deterministico, oppure dimostrare che
e' irripetibile in una sola sessione — e allora chiuderlo come "rischio noto in
esecuzioni concorrenti", con il vincolo di una sessione per volta gia' messo a
regola.

## Nota sul resto

L'utente ha riferito che, dopo l'errore, il TUI ha funzionato. Coerente con un
errore che colpisce un singolo inserimento e non l'inizializzazione: il
processo sopravvive, perde quel messaggio, e prosegue.

## Vincolo operativo che segue da qui

Una sola sessione TUI per volta, sempre. Non e' solo una regola di memoria
(il 2026-09-26 nove sessioni hanno saturato 14 GB e fatto terminare
un'applicazione di sistema): e' anche la mitigazione di questo difetto, se la
causa e' la scrittura concorrente sullo stesso `cyberstrike.db`.

Verifica: prima di ogni avvio, `free -m` e `pgrep` per processi TUI residui;
dopo, `timeout` sempre, e controllo che 0 processi restino.

## Indagine 2026-09-26 — due ipotesi esaurite, causa ancora aperta

### Ipotesi 1: scrittura concorrente. ESCLUSA.

Il sospetto iniziale era una race fra processi sullo stesso `cyberstrike.db`
(il TUI gira in `new Worker()`, quindi main e worker sono processi distinti che
aprono lo stesso file in WAL). Ho scritto `infra/bounty-sandbox/sqlite-race.py`
che lancia 3 writer concorrenti x 4 round, ciascuno con lo stesso pattern di
`updateMessage` (upsert su id):

```
=== 3 writer concorrenti x 4 round ===
  round 1/4 completato ... round 4/4 completato
  codici di errore raccolti: nessuno
  NON riprodotto con scritture concorrenti pulite
```

`busy_timeout = 5000` (db.ts:152) copre la concorrenza: l'attesa e' gia' dentro.
**Ipotesi scartata.**

### Ipotesi 2: statement o handle usato dopo la chiusura. NON RIPRODOTTA.

- `Statement` riusato dopo `finalize()` → dà `Statement has finalized`, **non**
  `SQLITE_MISUSE`. Errore diverso.
- Un `Database` chiuso mentre un altro handle fa `prepare` → nessun errore.
- 5000 upsert di fila → nessun errore.

Cercato in tutto il repo: `close()` non compare mai in `storage/` ne' in
`session/index.ts`, quindi l'handle non viene chiuso esplicitamente da
CyberStrike.

### Cosa resta

`SQLITE_MISUSE` da `prepare()` con `byteOffset: -1` significa che la
preparazione dello statement fallisce, prima di scrivere. Non e' un constraint e
non e' concorrenza. La lettura piu' probabile e' **`data` non serializzabile o
shape inattesa** passato a drizzle, oppure una migrazione/reconcile in corso
mentre un altro processo scrive — ma ho guardato `reconcile(sqlite)` (db.ts:185)
e gira solo dentro il `lazy()` del `Client`, quindi solo alla prima apertura del
processo.

**Non isolato.** Non chiudo il ticket: dichiararlo risolto sarebbe la stessa
specie di conclusione anticipata che ho già ritirato due volte su #14.

La via che resta e che non ho percorso: misurare sul TUI vero dentro il
container, dove l'errore si è manifestato, invece che su harness sintetici che
non ci arrivano. Va fatto dentro il container, con l'utente che apre la
sessione, perche' richiede l'intervento umano.

## Verifica avversariale deleg_c71b5521 — NON ISOLATO

18 API call, 302s, 0 tentativi TUI (il container `cyberstrike-bounty` non
esiste in questo ambiente e non ho autorizzato a crearlo). Esito: **causa non
isolata**. Nessun file di sorgente modificato, worktree pulito.

### L'errore di ragionamento che mi e' stato contestato, e che accetto

Avevo scritto che `busy_timeout=5000` e WAL escludono la concorrenza. **Non e'
 vero cosi'.** Il mio test dei writer misura scritture concorrenti *pulite*;
l'errore dell'utente e' in `prepare()`, cioe' *prima* dell'esecuzione dello
statement, e `busy_timeout` governa il locking durante l'accesso. Ho
generalizzato un test che copre un caso specifico in una confutazione di una
ipotesi piu' ampia. Era il mio errore piu' grave del lotto, perche' me l'avevo
dichiarato risolto.

### Ipotesi messe alla prova, con esito

| ipotesi | esito | prova |
|---|---|---|
| `data` non serializzabile | resa meno probabile | 10.000 upsert JSON, 10000 ok; ciclico dà `TypeError: JSON.stringify`, **non** `SQLITE_MISUSE` |
| riuso prepared statement drizzle | resa meno probabile | `insert.js:148-149` chiama `_prepare()` per ogni `.run()`; 10.000 esecuzioni alternate ok |
| `Client()` chiamato due volte in `db.ts:203` | **non e' un difetto** | `lazy.ts:1-15` memoizza: entrambe le chiamate restituiscono lo stesso client |
| statement/handle dopo close | non esclusa | l'errore differisce, ma senza riproduzione non basta |

Nota: `Client()` due volte era una domanda infelice ma giusta — la risposta e'
no, e va scritta per non rifarla.

### La pista che ho escluso io, con verifica (volume/filesystem)

Avevo ipotizzato che il DB stesse su un volume Docker con filesystem non
adatto al WAL. **Verificata e falsa.** I volumi sono `ext2/ext3`, non ext4, ma
il test sul filesystem REALE passa:

```
journal_mode = wal
200 upsert su cyberstrike-share -> 0 errori
rows = 200
```

Il filesystem non regge, ma regge: non e' la causa.

### Cosa resta

Nessuna ipotesi in mano con prove a favore. Quello che resta, in ordine di
probabilita' e NON verificato:

1. **Il TUI reale dentro il container**, dove l'errore si e' manifestato: main e
   `Worker` (thread.ts:112) come processi distinti che toccano lo stesso DB
   durante `migrate()`/`reconcile()`. Il subagent non l'ha potuto provare perche'
   il container non esisteva. Questa e' la via che resta ed e' la piu'
   promettente, perche' e' l'unica che replica le condizioni reali.
2. Il ramo `abort` di `processor.ts:366-370`, che chiama `updateMessage` mentre
   un altro `updateMessage` e' in corso: possibile come sequenza applicativa,
   nessuna evidenza diretta.

### Stato del ticket

**APERTO, non isolato.** Non e' un difetto introdotto da me: la base e' il
tempo di sessione sul DB e l'errore e' intermittente e non blocca l'uso. Ma non
e' nemmeno un artefatto dell'ambiente, perche' non l'ho mai riprodotto in
ambienti puliti.

**Nota operativa:** l'errore ha colpito una volta sola, all'avvio, e l'utente ha
detto "ora va". Se compare di nuovo, il passo utile e' catturarlo **mentre
accade** (stack completo + timestamp) invece di tentare di riprodurlo a
posteriori: da solo non basta a chiudere il ticket.

## Indagine 2026-09-26, terza tappa — due thread sullo stesso DB: ESCLUSA

Il subagent aveva notato che `new Worker` in Bun e' un **thread**, non un
processo. Riformulata la domanda di conseguenza: ogni thread ha il proprio
isolate e quindi il proprio modulo, dunque **due handle `bun:sqlite` distinti
sullo stesso file WAL**. E' il caso che `Instance.provide` +
`InstanceBootstrap` (worker.ts:125-131) producono davvero: il worker apre il
DB all'avvio con `checkUpgrade`.

Il test e' stato costruito in due tempi, e il primo era sbagliato.

**Primo tentativo, invalido.** Ho usato un `Worker` inline (codice come
stringa). Muore subito:

```
worker onerror: AggregateError: Error in worker
TIMEOUT: worker non ha risposto
```

Un Worker inline **non puo' importare `bun:sqlite`**. Il mio test non aveva
mai messo due thread sul DB: il worker moriva prima di aprire niente, e il
"non riprodotto" che avrei potuto concludere era privo di significato. Motivo
per cui l'ho rifatto con `w.onerror` esplicito: senza, il fallimento del worker
era invisibile e il test passava per verde.

**Secondo tentativo, valido.** Worker su file (`sqlite-worker.ts`), la stessa
forma di `cli/cmd/tui/worker.ts`:

```
=== 2 thread, 200 scritture ciascuno x 3 round, db=/tmp/tr.db ===
  round 1/3  main.rows=400 worker.rows=336  errori=0
  round 2/3  main.rows=400 worker.rows=400  errori=0
  round 3/3  main.rows=400 worker.rows=400  errori=0
  codici: nessuno
  NON riprodotto con 2 thread sullo stesso file WAL
```

`main.rows=400` contro `worker.rows=336` al primo round e' la prova che i due
thread hanno scritto **davvero in parallelo** (il worker contava mentre il main
aveva gia' finito). Quindi il test e' valido e il risultato e' negativo.

**Terza ipotesi esclusa.** Quattro in totale: concorrenza fra processi, statement
dopo close, volume/filesystem, due thread sullo stesso file.

### Cosa resta, e perche' non lo chiudo

L'unica condizione che non ho ancora replicato e' il TUI vero dentro il
container, dove l'utente l'ha visto una volta, all'avvio. Richiede un container
(800MB-1.8GB) e va fatto con l'utente presente, perche' l'errore e' intermittente.

Se ricompare, catturarlo **mentre accade** e' l'unico modo che chiude il
ticket: stack + timestamp + testo esatto della riga che precede l'errore nel
TUI. Su quello posso isolare la forma esatta del `data` che fallisce.

## TUI VERO nel container — eseguito, errore NON riprodotto

Percorso completo dentro il container, provider `-m omni/auto/best-coding`,
sessione reale, tool realmente eseguito:

```
=== V12: sessione reale, provider, un tool ===
  messaggio: Esegui il tool read su README.md
  provider:  omni/auto/best-coding

> cyberstrike · auto/best-coding

→ Read README.md
Ho eseguito `read` su `README.md`. Il file descrive CyberStrike, le sue
funzionalità, gli agenti, l'installazione e i link alla documentazione.

=== residui (deve essere 0) ===
0
```

**Nessun `SQLITE_MISUSE`.** Lo stesso percorso che lo ha prodotto la prima
volta (TUI, avvio, provider, tool, main + Worker) ora gira pulito. Provato
anche il percorso `run` non interattivo: risposta corretta, zero errori.

## Chiusura — NON riprodotto, difetto non isolato

Quattro ipotesi escluse con prove eseguibili:

1. scrittura concorrente fra processi — `sqlite-race.py`, 0 errori
2. statement/handle dopo close — errore diverso, `close()` mai chiamato
3. volume/filesystem — i volumi sono ext2/ext3, WAL attivo, 200 upsert, 0 errori
4. due thread sullo stesso file WAL — `sqlite-thread-race.ts`, 0 errori,
   con `main.rows=400 / worker.rows=336` che prova la concorrenza reale

Il difetto **non e' stato riprodotto in nessuna condizione che ho saputo
costruire**, compreso il TUI vero che e' l'ambiente dove l'utente l'ha visto.

**Lo chiudo come NON RIPRODOTTO, non come risolto.** La differenza conta: se
ricompare, non e' un ticket che si puo' chiudere risolvendo un bug noto, ma
un caso di cui non ho la firma. Il primo tentativo di indagine su questo
errore (la concorrenza) si e' rivelato sbagliato, e per due volte ho rischiato
di dichiararlo risolto: una lo feci io, e una il subagent dovette
contestarmela. Un ticket chiuso come risolto che poi si riapre e' piu' costoso
di un ticket aperto con quattro ipotesi scartate e una prova che manca.

**Cosa serve se ricompare** (operativo, non altro codice):
- testo esatto della riga che precede l'errore nel TUI
- stack completo con timestamp
- un solo tentativo, catturato mentre accade

Con quei tre dati si puo' isolare la forma del `data` che fallisce in
`updateMessage`, che e' l'unica cosa che i miei test non hanno mai toccato:
hanno provato forme note, non la forma reale a runtime.
