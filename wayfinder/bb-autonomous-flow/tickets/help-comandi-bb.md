# Ticket: help dei comandi bb (scopribilità e accuratezza)

## Stato: CHIUSO (2026-09-28) — il difetto descritto qui sotto era STALE

Il difetto originale ("`bb --help` non elenca le azioni") **non esiste più**:
misurato col CLI reale, `bb --help` elenca tutte e dodici le azioni. Il
comando era già stato dichiarato correttamente.

Il difetto **vero**, trovato misurando, è un altro ed è più grave.

## Il difetto vero: `cyberstrike bb` da solo moriva in silenzio

Fatto misurato (CLI reale, questo host, `LANG=it_IT.UTF-8`):

```
$ cyberstrike bb      -> rc=1, ZERO byte di output
$ cyberstrike bb --help -> rc=0, 1965 byte, tutte e 12 le azioni
$ cyberstrike mcp     -> rc=1, ZERO byte di output
```

Con `LANG=C` lo stesso `bb` stampa l'help. Quindi il difetto compare
**proprio sul sistema in italiano** di chi usa il tool: l'utente che vuole
l'elenco dei comandi digita `bb` e riceve una riga vuota e un codice di
errore senza spiegazione. Sembra un hang.

## Causa: una chiave mancante in `yargs/locales/it.json`

Non è un difetto di `bb`. La catena, verificata nel sorgente di yargs 18.0.0:

1. yargs indovina la locale da `LC_ALL` → `LC_MESSAGES` → `LANG` → `LANGUAGE`
   (`yargs-factory.js:1072`, `kGuessLocale`);
2. carica `yargs/locales/<lang>.json`;
3. `it.json` **esiste** ma è **incompleto**: contiene `Commands:` e `Options:`, e
   **non** contiene `Not enough non-option arguments` — il messaggio che
   `demandCommand()` usa quando manca l'azione;
4. la chiave assente **non produce un fallback in inglese**: produce
   `undefined`, che non stampa nulla.

Lo stesso vale per `mcp` e per tutti gli altri gruppi che usano
`demandCommand()` (12 gruppi: auth, mcp, session, provider, agent, skill,
github, debug/*). Nessuno aveva `handler` esplicito, quindi il vuoto era
condiviso.

## Fix applicato

Due livelli, come deciso con l'utente:

1. **`.locale("en")` in `src/index.ts:50`** — nel punto unico di costruzione
   del CLI. Disattiva il rilevamento automatico e tiene i messaggi di yargs in
   inglese: il progetto scrive già tutti i propri testi in inglese. Risolve
   tutti i 12 gruppi insieme invece di una toppa per comando.
2. **`.demandCommand(1)` + handler che stampa l'help in `bb.ts`** — dichiarare
   l'intenzione esplicitamente, e se `demandCommand` smettesse di intercettare
   il caso, l'help è la risposta utile a "cosa scrivo qui dentro?", non un
   errore secco.

La forma vuota `handler: async (args) => {}` che c'era prima **era** il difetto:
il comando ci cascava dentro e non faceva nulla. Ora l'handler è esplicito.

## Verifica

`test/cli/bb-help.test.ts`, 3 test:
- `bb` da solo dice qualcosa (nel locale di default e in `it_IT` esplicito);
- `bb --help` elenca le azioni anche in italiano.

Controprova a `HEAD` (fix tolto, test invariato): `bb` in italiano → `rc=1`,
0 byte; test → `1 pass 2 fail`. Col fix → `3 pass 0 fail`.

**Controprova oltre il ticket**: `mcp` da solo, che non è oggetto di questo
ticket, è tornato a stampare l'help grazie al fix globale.

## Cosa NON ho fatto (e perché)

Non ho completato `it.json` con le chiavi mancanti. Sarebbe stato il fix
"più gentile", ma significa mantenere una traduzione che yargs 18 non carica
più correttamente e che andrebbe sincronizzata a ogni versione; forzare `en`
è una riga e non si rompe. Le etichette italiane automatiche nelle opzioni
(`[booleano]`, `[stringa]`) spariscono: era quanto richiesto, e sono solo
etichette di tipo, nessuna informazione persa.

## Insieme di note (originali, ora superate dal misurato)

`cyberstrike bb <action>` è registrato nell'help top-level ma le azioni
restavano invisibili. L'inciampo concreto già osservato: l'utente ha digitato
`cyberstrike bb connect` senza sapere che il comando esisteva, e prima ha
provato a invocarlo dentro la TUI (dove `bb` non è un comando).

Come rendere le azioni `bb` scopribili e l'help fedele al comportamento reale?

## Context

- Stato verificato (2026-09-24, binario installato):
  - `cyberstrike --help` → elenca `bb`, `hackbrowser`, ecc. (26 comandi)
  - `cyberstrike bb sync --help` → descrizione + positional `program` e opzioni
    globali. **Nessuna menzione** di: limite 100 scope, assenza di known
    issues, scrittura di `<handle>.policy.md`
  - `cyberstrike bb crawl --help` → descrizione, `--target`, `--steps`,
    `--credential`, `--headfull` (ok, completo)
  - `cyberstrike bb --help` → **nessun elenco azioni**
- Nota storica: la confusione "il comando cyberstrike bb connect non lo trova"
  è stata causata in parte da questo (il comando c'era; l'help non lo mostrava).
- File: `packages/cyberstrike/src/cli/cmd/bb.ts` (definizione comandi/descrizioni),
  `packages/cyberstrike/src/cli/cmd/hackbrowser.ts`.
- Contesto correlato: [identity-da-policy] — anche la descrizione di `bb sync`
  dovrà cambiare quando il sync deriverà l'identity.

## Da decidere

1. Elenco azioni: aggiungere un blocco `Examples:` / elenco azioni nella
   descrizione di `cyberstrike bb` (yargs `describe`), o un sub-command
   `bb help` esplicito? Vale anche per `hackbrowser`?
2. Accuratezza: descrivere in `bb sync --help` i limiti reali (100 scope senza
   paginazione, niente known issues/hacktivity, policy troncata a 500 char nel
   JSON + integrale su `.policy.md`) — help lungo ma onesto, o rimando a
   BUG_BOUNTY_PLAN.md?
3. `bb connect --help` deve riflettere il flusso attuale a 2 passi e la
   mascheratura del token (oggi non lo fa).
4. Coerenza: allineare le descrizioni anche quando cambia il comportamento
   (es. se `bb sync` popolerà `identity`, la frase "no token needed for public
   programs" va corretta per dire cosa fa col token).

## Difetti adiacenti emersi leggendo sync.ts (valutare se ticket separato)

- `structured_scopes(first:100)` e `bounty_table_rows(first:100)` senza
  paginazione: su programmi grandi gli asset oltre il 100° spariscono in
  silenzio (nessun warning).
- Asset **wildcard** (`https://*.hackerone-user-content.com/`) restano stringhe
  grezze in `scope.in`; il blocco in `api.ts` che converte scope→pattern salta
  i target con prefisso `http`, quindi i wildcard non generano pattern per il
  crawler.
- `scope.out` contiene solo le esclusioni strutturate (`declarative_policy`);
  le esclusioni testuali restano confinate nel `.policy.md`.