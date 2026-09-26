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
