# Difetto #14 — misurato il 2026-09-26

## La descrizione del difetto era sbagliata

Issue #14 (e il ticket TUI) descrivevano: "dopo l'invio lo schermo diventa
vuoto". La misura mostra che **non è mai stato uno schermo vuoto**. Il TUI
disegna normalmente — logo, prompt, sessione, tab — e lì resta.

Il vero difetto è uno dei due, e sono due cose diverse:

- **l'input non entra** (l'ipotesi più forte, misurata), oppure
- **l'input entra e viene perso** a valle.

## Cosa è stato misurato

Uno strumento nuovo, `infra/bounty-sandbox/pty-drive.py`, con un PTY vero a
140x40 dentro il container. `tui-screen.py` ricostruisce lo schermo dal log
grezzo replayando le sequenze ANSI, che distingue "i byte c'erano ma il testo
è stato cancellato" da "non è arrivato niente".

```
$ measure-tui.sh          # schermo ricostruito
15 righe non vuote su 40
  ______      __              _____ __       _ __
  / ____/_  __/ /_  ___  _____/ ___// /______(_) /_____
  ~/hermes/.../cyberstrike:feat/bug-bounty-enhancement  ⊙ 0 MCP
  Ask anything... "Fix a TODO in the codebase"
```

Il TUI **disegna**. Non è un difetto di rendering.

Poi, sullo stesso log:

```
'rispondi' presente: False
'OK14' presente: False
'esattamente' presente: False
```

**Il messaggio inviato non è mai comparso a schermo.** Mentre un tasto singolo
sì:

```
$ tui-input.py --key x --mode raw
chiave_'x'_a_schermo=True
```

Quindi il canale di input funziona per i singoli caratteri ma **non per un
messaggio**. Il TUI attiva `ESC[?2004h` (bracketed paste) e `ESC[?2026h/l`
(synchronized output) 14+ volte.

## Cosa è davvero da chiarire

La domanda aperta non è più "perché lo schermo si svuota" ma: **perché un
messaggio con più caratteri non entra, quando un singolo carattere sì**.

Due candidati, non ancora separati:

1. il TUI, in modalità bracketed paste, scarta ciò che non è delimitato da
   `ESC[200~` / `ESC[201~` — cioè non è un problema del TUI ma **del mio
   driver**, che invia testo grezzo;
2. il TUI legge l'input ma qualcosa a valle lo perde.

La (1) è la più probabile e **riguarda lo strumento di misura, non il
prodotto**. Finché non è separata, #14 non èisolato: non si sa se esiste un
difetto nel TUI o solo nella mia misura.

## Due difetti miei, durante la costruzione dello strumento

Li metto qui perché hanno falsato la prima diagnosi:

1. **Baseline preso troppo presto.** La prima misura ha dato
   `RISPOSTA_RENDERIZZATA` con 1456 byte "cresciuti". Falso: avevo preso il
   riferimento a un istante fisso, e i miei stessi dati (`silenzio_a_s`
   continua da 0.0 a 12.2s) dicevano che il TUI non aveva ancora disegnato.
   Quei byte erano il **primo render**, non la risposta. Ora il riferimento si
   prende dopo il primo byte reale e un silenzio di `--settle`.
2. **Ciclo che non finisce.** riusavo la stessa variabile per l'orologio
   dell'invio e per quello di uscita: dopo l'invio spostavo l'uscita a
   `hold + 1e9` e il ciclo non terminava più.

## Difetto grave, di pulizia — sistemato

Il driver lanciava il TUI e usciva lui **senza terminare il figlio**. Nove
misure hanno lasciato nove Bun da ~800 MB: ~6,8 GB, e su 14 GB di RAM
l'`oomd` ha terminato un'applicazione di sistema.

Entrambi i driver ora hanno `atexit` + `killpg` sull'intero albero di processi,
e i container hanno `--memory=2g`. Verificato: dopo un run, 0 processi TUI
vivi.

## Stato

**Non risolto.** La causa non e' isolata. Il criterio di chiusura di #14 resta
quello giusto: una sessione reale, messaggio inviato, risposta **resa a
schermo**, almeno un tool eseguito.

## Seconda misura — l'input non entra, e il difetto NON e' del mio harness

Dopo la correzione del timing (attesa di stabilizzazione, `--settle`) ho
riprovato. Il testo continua a non entrare:

```
INVIATO[cr] a_s=9.8 payload=b'ciao zio\r'
byte_finali=10839
chiave_'ciao zio'_a_schermo=False
```

Quindi non era una questione di quando ho inviato.

**Test di controllo, questo e' il passaggio decisivo.** Ho fatto recapitare gli
stessi byte dal mio harness a `cat` in raw mode:

```
INVIATO[raw] a_s=6.0 payload=b'ABCDEFGH'
raw catturato: b'ABCDEFGH'
```

Il trasporto dei tasti del mio harness **e' corretto**. Quindi il difetto e'
del TUI e non dello strumento di misura. Prima misura in cui la domanda era
"dove e' il difetto?" ha una risposta.

Una nota che corregge un'altra credenza mia: quei 10.633 byte "cresciuti dopo
l'invio" **non** erano il testo che entrava. Sono ridisegno. Nella seconda
meta' del log non c'e' `ciao`, e quello che si legge e' il nome del modello,
che **cambia da solo** fra un render e l'altro (`DeepSeek V4.1 Flash`, poi
`Nano Banana Pro Preview`, entrambi OpenRouter). Il TUI ridispiega a caldo
mentre io scrivo. Crescita di byte non vuol dire input ricevuto.

## Cosa so del TUI, dal codice

Il TUI non e' Ink: e' **Solid + `@opentui/solid`**, con un parser di input
proprio (`node_modules/@opentui/core`, ~742 KB). Fa `stdin.setRawMode(true)` e
`stdin.on("data", ...)` (`index-nkrr8a4c.js`).

Un dettaglio che va tenuto presente: `thread.ts:112` avvia il TUI dentro un
`new Worker(...)`, cioe' un worker, non il processo principale. Se il worker
non eredita lo stdin, l'input non arriva — ma questo spiegherebbe il difetto
sempre, anche sulla macchina dell'utente, e li' il TUI funziona. Quindi
`Worker` non basta a spiegare: manca il pezzo che distingue il mio ambiente
da quello interattivo.

## Cosa resta aperto

La causa nel TUI **non e' isolata**. Il difetto e' definitivamente nel TUI, ma
non so ancora se e' un difetto del prodotto o una condizione del mio ambiente di
misura (PTY sintetica, dimensione, focus, `TERM`). Non lo dichiaro risolto.
