# Ticket: il TUI funziona dentro il container — la diagnosi precedente era sbagliata

Stato: **APERTO (2026-09-26)** — il TUI si apre, il difetto è a valle.
Ultimo commit al momento della stesura: `404d18130`.

## Cosa dice l'utente (fatto, non ipotesi)

Avvia il container, esce `bash`, lancia `bun run dev`, che esegue:

```
bun run --cwd packages/cyberstrike --conditions=browser src/index.ts
```

Da lì **il TUI si apre** (schermata simile a OpenCode), configura il provider,
scrive un messaggio. **A quel punto arriva lo schermo vuoto.**

## Perché la diagnosi precedente è sbagliata

Il ticket precedente (`defetto-tui-container-vuoto.md`, commit `340eeb5ed`)
concludeva: "il TUI non parte / non disegna / dimensioni del terminale". Erano
tre conclusioni sbagliate, e le ho prese tutte e tre per misure che non
dicevano quello che credevo.

| Misura | Interpretazione sbagliata | Interpretazione corretta |
|---|---|---|
| `strace`: 0 scritture su fd 1 | il TUI non scrive | il PTY del mio test non è un terminale, quindi `write` va a un fd diverso / il wrapping falsava il conteggio |
| `rows/columns = undefined` / `0` | il TUI riceve dimensioni zero e disegna il vuoto | senza `-t` non è un terminale; con `-t` un PTY 0×0 è artefatto del mio harness, non del suo terminale |
| modulo TUI: `Cannot find module 'react/jsx-dev-runtime'` | dipendenze rotte, TUI non caricabile | il TUI **si apre**: quell'errore è del mio `bun -e import()` che risolve `react` fuori dal contesto Solid; non è lo stesso code path |

## Cosa ho misurato davvero (con PTY vero 140×40)

Ho costruito un PTY con `pty.fork()` + `TIOCSWINSZ` esplicito a 140×40 dentro
il container, e ho lasciato vivere il TUI **150 secondi** (la migrazione del DB
da sola ne mangia decine).

```
[FASE 1] vivo=True byte=20885
  ESC=887
  token ESC più frequenti:
    192x  ESC[48;2;0;0;0m      <- colore di sfondo nero, il TUI colorava
    159x  ESC[38;2;255;2...m   <- colore del testo
     10x  ESC[?25l / ESC[?25h  <- mostra/nascondi cursore
      6x  ESC[?2026h / l       <- modalità sincronizzata
      6x  ESC[22;37H           <- posizionamento cursore a riga 22, colonna 37
```

**Il TUI sta disegnando.** Sta impostando colori di sfondo, colori di testo,
posizioni di cursore. Non è un TUI che non parte: è un TUI che rende.

Le righe di testo non sono visibili perché il renderer **usa il posizionamento
assoluto del cursore** (`ESC[22;37H` = "vai a riga 22, colonna 37") invece di
newline: il testo è sparso sullo schermo, non in un flusso lineare. Il mio
"3 righe" era un artefatto del modo in cui ho contato.

## Il punto in cui la catena si spezza

L'utente scrive un messaggio e **allora** arriva il vuoto. Quindi il difetto
è nel percorso del messaggio: invio → creazione sessione → prima risposta del
provider → render. Non nell'avvio.

**Non ho ancora misurato quel passaggio.** È quello che va fatto adesso.

### Cosa NON è il difetto (scartato con misura)

- **Non è il TTY.** Con PTY a 140×40 reali il TUI disegna. Le dimensioni non
  sono la causa.
- **Non è `TERM`.** `xterm-256color` è impostato e i colori vengono emessi
  correttamente.
- **Non è il renderer nativo Zig.** Sta funzionando: emette sequenze
  posizionali e di colore.
- **Non è il provider.** L'utente lo configura dal TUI prima di scrivere, e un
  provider mal configurato darebbe un errore *visibile*, non il vuoto.
- **Non è Chromium/mancanza di browser.** Il TUI parte prima, e il browser
  serve all'agente, non al TUI.

### La falsa pista che ho inseguito io

Il mio test interattivo ha scritto `ciao, dimmi chi sei` **crudamente** sul PTY.
Il TUI ha letto quei caratteri come **scorciatoie**, non come testo: la `c` ha
aperto la command palette e la riga che ne è uscita è

```
ciao dimmi chi sei    No results found
```

confermata a `packages/cyberstrike/src/cli/cmd/tui/ui/dialog-select.tsx:270`.
Quella riga **non è il difetto** e non va usata come prova di niente: è
inquinamento del mio test, e l'ho marcato come tale.

## Cosa va fatto (prossimo passo misurato)

1. **Riprodurre con input fedele**: il TUI non va pilotato con caratteri
   grezzi. Serve o un paste lento (perché il TUI ha gestione della composizione
   / `bracketed paste`), o il suo protocollo di input. Scrivere il messaggio
   come lo scriverebbe un utente è il punto.
2. **Catturare l'errore invece del vuoto**: se dopo l'invio esce un errore ma
   il TUI lo cancella con un clear, il "vuoto" è un errore **nascosto**, e va
   cercato nel DB/log, non a schermo.
3. **Guardare i log del container** dopo l'invio: il provider è remoto
   (`192.168.49.84:20128`, OmniRoute), quindi un errore di rete o un 401
   arriverebbe lì.
4. **Il caso "provider configurato a mano dal TUI"** è diverso da quello che
   ho risolto io (`cyberstrike.json` + `HERMES_CUSTOM_OMNI_API_KEY` via
   `run-sandbox.sh`): se il TUI scrive la config in un posto che il processo
   non rilegge, o se non la rilegge senza riavvio, il sintomo è proprio
   questo.

## Implicazioni sulla MAP (vedi `MAP.md`, sezione "Verifica — arretrati")

- `V6` era dichiarato "risolto per via d'impianto". **Va riletto**: il
  funzionamento del TUI è dimostrato, ma l'uso reale del flusso bug bounty
  dentro il container non è ancora dimostrato, e quello è il punto di V6.
- Il precedente ticket del TUI vuoto era **prematuro**: chiudeva un difetto che
  non era quello. Va tenuto come "misure interpretate male", non come
  "difetto risolto".

## Disallineamenti trovati durante questa diagnosi (da correggere in MAP)

1. **`struttura-directory-progetto` (riga 43 della MAP) dice `~/bugbounty/`**,
   la realtà è `~/.cyberstrike/bugbounty/programs/<programma>/`. `~/bugbounty`
   non esiste. La decisione 1A è stata superata da `$CYBERSTRIKE_HOME` +
   `programs/`.
2. **Budget container**: la MAP dichiara "2g RAM / 256 pid", il container
   gira con `--memory=3g --pids-limit=1024`. La MAP non riflette l'impianto.
3. **`E1` non è chiuso**: `buildProjectRuleset` ha **zero** chiamanti di
   produzione. Gli unici riferimenti sono quattro file scratch `_adv*.ts`
   committati per errore, che vanno rimossi.
4. **`_adv*.ts`**: `packages/cyberstrike/_adv{,2,3,4,-always}.ts` sono
   spazzatura di subagent **tracciata in git**, con zero riferimenti. Vanno
   cancellati, non archiviati.

## Criterio di chiusura

Il difetto è chiuso quando **una sessione reale** dentro il container
mostra: messaggio inviato → risposta del provider resa a schermo → almeno un
tool dell'agente eseguito. Non quando "il processo non crasha" e non quando
"produce byte". I byte li produceva già prima.
