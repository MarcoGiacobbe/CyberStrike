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

## Difetto residuo: la cwd del sandbox resta /app

Il perimetro applicativo ora e applicato, MA il sandbox continua a far
partire `run` da `/app`, che e la copia READ-ONLY del codice di CyberStrike.
L-agente quindi cerca i dati del programma nel posto sbagliato.

Misurato (2026-10-02, run reale in sandbox):
- col perimetro: `bash (ls -la /app/packages/cyberstrike/scope.md ...)` negato
  alla riga 8 del log, prima che il perimetro perda efficacia;
- a HEAD: `external_directory (/dev/*)` richiesto alla riga 86.

Il perimetro e dunque reale e precoce. Ma blocca invece di guidare: il
l-agente non trova i file e prova a cercarli altrove.

### RISOLTO (misurato 2026-10-02): era il seed della config, non la cwd

`--dir` verso la directory del programma crashava con `no providers found`.
Tre misure, in ordine:

1. **La cwd non c'entra.** `run --dir /app`, cioe la STESSA directory di default,
   crashava uguale. Non era lo spostamento della cwd.
2. **Dove cerca davvero.** `config.ts:171` fa
   `Filesystem.findUp("cyberstrike.json", Instance.directory, Instance.worktree)`,
   cioe risale dalla directory del progetto. Da `/app` trovava
   `/app/cyberstrike.json` (nel repo, montato `:ro`). Dalla directory del
   programma risale fino a `/work/bugbounty/programs/bcny` e non trova niente.
3. **Il seed scriveva un livello troppo in basso.** Il launcher copiava la
   config in `VOL_CFG/cyberstrike.json`, ma `Global.Path.config` =
   `$XDG_CONFIG_HOME/cyberstrike` (`global/index.ts:10`) e
   `XDG_CONFIG_HOME=/home/hunter/csconfig`, quindi il codice cerca
   `/home/hunter/csconfig/cyberstrike/cyberstrike.json`. Un livello di troppo.

Da `/app` il provider funzionava solo per caso: la config montata non era mai
letta, e si recuperava il `cyberstrike.json` del repo. Il bug era latente da
sempre e si vedeva solo cambiando la cwd.

Correzione: il seed scrive in `/dst/cyberstrike/cyberstrike.json`. La
subdirectory deve preesistere nel volume, perche il container monta `VOL_CFG` in
sola lettura e `mkdir` in `Config` fallisce con `EROFS`.

**Controprova** (seed riportato al percorso sbagliato, volume ricreato da zero):
il run muore con `EROFS`. Con il seed corretto: parte e risponde. Il test
misura il fix, non il caso.

**Esito misurato in sandbox su `bcny`, `run --dir` + `--perimeter`:**
- l'agente elenca `AGENTS.md` e `scope.md` (prima leggeva
  `/app/packages/cyberstrike`, 37 voci di sorgente, zero asset);
- `/app/package.json` resta negato dal perimetro.

Difetti preesistenti NON toccati da questa correzione: `read.ts` usa il path
originale invece del canonico restituito dal controllo; `openChecked()` usa
`O_NOFOLLOW` solo sull'ultimo componente, lasciando i parenti seguibili in una
finestra TOCTOU. Sono fuori dallo scope di A2 e vanno verificati a parte.

## Correzione: l'ordine delle regole non e cio` che pensavo

Il primo commento nel codice diceva che il perimetro va DOPO `question: deny`
perche `PermissionNext.evaluate` usa `findLast`. **La giustificazione era falsa**:
`buildProjectRuleset()` non emette nessuna regola per `question` (le regole sono
per `edit`, `external_directory`, `bash`, `bash_unresolved`, `read`), quindi le
due non si incontrano mai. Verificato evaluando entrambi gli ordini:
identico risultato. L'append in coda resta la forma giusta perche' e la stessa
di `bb hunt`, non perche `findLast` lo richieda.

## Altro misurato: `read` su path esterno e`ask`, non concessa

Non esiste un'azione di lettura che il default dell-agente conceda per un
path fuori dal progetto: anche `read` chiede `external_directory` e viene
negata in non-interattivo. Quindi un test che confronta "leggo fuori" con e
senza perimetro NON distingue: entrambi negano. L'unico test che dimostra
che il perimetro aggiunge un confine e` scrivere DENTRO, che a HEAD fallisce.

## Stato

`test/cli` 100/100, `bun turbo typecheck --force` 11/11. Verifica indipendente
avversariale: **PATCH SOLIDA**, controprova falsificata (facendo chiedere il
permesso anche al caso che si aspettava 0, il test e' diventato rosso:
`Expected: 0 / Received: 1`) e ripristinata. Il verificatore non ha coperto
timeout reali e ogni variante di `DeniedError`: copre il percorso `ask`
non-interattivo.
