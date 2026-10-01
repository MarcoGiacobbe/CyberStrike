# Falso successo: `run` non interattivo esce 0 dopo aver negato un permesso

## Difetto misurato (2026-10-01)

Primo run reale della simulazione `bcny` nel sandbox:

```
./infra/bounty-sandbox/run-sandbox.sh --program bcny run "Racconta il programma: ..."
```

Risultato: **36 s, exit 0**, due auto-rifiuti su `/dev/*`, **nessun** `state.json`,
nessun report, browser mai avviato, database non aggiornato. La sessione non aveva
potuto fare nulla ma il processo si dichiarava riuscito.

Causa: in non-interattivo `run.ts` rispondeva `"reject"` a ogni `permission.asked`
(serve un umano, non c'e') e poi non guardava `session.error` per determinare l'uscita.

## Correzione

`packages/cyberstrike/src/cli/cmd/run.ts`:

- raccoglie i `permission.asked` auto-rifiutati in `deniedByAsking`;
- dopo il loop, se `session.error` c'e' oppure `deniedByAsking` non e' vuoto, stampa
  `UI.error` con **quale** permesso mancava e perche' non puo' proseguire, ed esce 1.

Non cambia nessuna regola: `ask` resta `ask`, `deny` resta `deny`. La patch rende solo
visibile un fallimento che prima era silenzioso. Non e' un preapprovvamento.

## Difetto collaterale scoperto strada facendo

`run.ts:367` costruisce `rules` con un solo `question: deny` e chiama
`sdk.session.create({ permission: rules })`. La chiave `permission` della **config
globale non viene letta da `run`**: dichiarare `permission: { bash: "ask" }` in config
non ha alcun effetto. Il perimetro di un programma entra solo da `bb hunt`.

Conseguenza per i test: un test che vuole far scattare un `ask` **non puo' dichiarare
regole in config** — le verrebbe scartate. Deve usare un'azione che il *default
dell'agente* mette in `ask`: `external_directory: { "*": "ask" }` e
`read: { "*.env": "ask" }`. Nel test il permesso che scatta e' `external_directory`
perche' il path letto e' fuori dal progetto.

## Test

`packages/cyberstrike/test/cli/run-permission-ask.test.ts`, process-level: spawna il
vero `./src/index.ts run` con un provider OpenAI-compatible finto (`Bun.serve`).

- **rosso a HEAD** per la ragione giusta (`expect(r.code).not.toBe(0)` -> "Expected: not 0");
- **verde col fix**;
- controprova: sessione che non chiede nulla esce ancora **0** — il fix non trasforma
  ogni sessione in un errore.

Dettagli del fake, perche' servono e non sono ovvi:

- un tool_call SSE senza `index: 0` fa fallire l'SDK con `AI_TypeValidationError`;
- `finish_reason: "stop"` chiude il turno e **ignora** la tool call: serve `"tool_calls"`;
- il tetto di chiamate serve, altrimenti il finto chiede all'infinito (misurato: 21
  richieste, processo ancora vivo a 120 s) e il test misurerebbe un timeout invece
  dell'uscita;
- le richieste senza `tools` sono la generazione del **titolo** e vanno risposte con
  testo, altrimenti la sessione non parte.

## Limiti del messaggio, decisi e non casuali

- Un `deny` **non** passa da qui: lancia `DeniedError` dentro
  `PermissionNext.ask` e l'evento `permission.asked` non viene pubblicato. Quindi
  `deniedByAsking` non puo' contare un `deny` e non c'e' doppio conteggio con
  `error`. Se in futuro `permission.asked` diventasse emesso anche per `deny`, qui
  comparirebbe un doppio conteggio: e' il segnale da guardare.
- Un **timeout** e' un `session.error` del provider, non un timeout di `run` (che
  non ne ha). Resta un timeout, col messaggio del provider, e non viene mischiato
  con "permesso manca": i due rami sono distinti e il primo esce subito.
- Il messaggio di errore **non** suggerisce piu' di dichiarare `permission` in
  config: prima lo faceva, ed e' un suggerimento falso per quanto misurato sopra.

## Stato

`test/cli` 100/100, `bun turbo typecheck --force` 11/11. Verifica indipendente
avversariale: **PATCH SOLIDA**, controprova falsificata (facendo chiedere il
permesso anche al caso che si aspettava 0, il test e' diventato rosso:
`Expected: 0 / Received: 1`) e ripristinata. Il verificatore non ha coperto
timeout reali e ogni variante di `DeniedError`: copre il percorso `ask`
non-interattivo.
