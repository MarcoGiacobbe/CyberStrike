# Ticket: help dei comandi bb (scopribilità e accuratezza)

## Question

`cyberstrike bb <action>` è registrato nell'help top-level (riga:
`cyberstrike bb <action>  manage bug bounty programs`) ma **`cyberstrike bb
--help` non elenca le azioni**: connect, disconnect, whoami, mail, sync,
accounts, list, info, add, remove, crawl restano invisibili a chi non sa già
che esistono. L'inciampo concreto già osservato: l'utente ha digitato
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