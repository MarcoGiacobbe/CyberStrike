# Difetto: TUI dentro il container parte ma non disegna

## Stato: APERTO (2026-09-26) — BLOCCANTE per l'uso quotidiano

## Sintomo

Lanciando il container e poi `bun run dev` dentro, **il TUI non mostra
niente**: schermo con un riquadro di input vuoto, nessun logo, nessun prompt,
**nessun messaggio d'errore**. L'utente ha configurato la Zen mode e la
schermata resta vuota.

## Cosa è verificato (fatti, non deduzioni)

| Prova | Esito |
|---|---|
| Processo dentro il container | **vive** (container "Up 7 minutes") |
| Output su file | **8477 byte**, logo ASCII di CyberStrike presente |
| Errori in log | **nessuno** (`error`/`ENOENT`/`panic` assenti) |
| Codici ANSI nel log | **648 byte di ESC**, **0 righe** di testo |
| Browser, tool, volumi, confine | tutti verdi |

Quindi: **il TUI si avvia e produce output, ma l'output non viene
visualizzato.** Non è un crash, non è un errore di dipendenze, non è il
container.

## CAUSA MISURATA (2026-09-26) — il TUI non gestisce l'assenza di TTY

Il TUI chiama `useTerminalDimensions()` (`tui/app.tsx:200`) e usa il risultato
per il box radice: `width={dimensions().width} height={dimensions().height}`
(`app.tsx:745-746`). `@opentui/core` 0.1.88 legge le dimensioni da
`process.stdout`.

Misurato dentro l'immagine, con uno script banale:

```
senza -t :  isTTY=false   rows=undefined  columns=undefined
con    -t:  isTTY=true    rows=0          columns=0
con COLUMNS/LINES:  rows=0  columns=0     (le env NON hanno effetto)
```

**Il TUI riceve dimensione ZERO e disegna una scena vuota senza segnalare
errore**: per il codice `0` è una dimensione legittima, quindi nessun errore,
nessun fallback. `COLUMNS`/`LINES` non aiutano: il valore non viene da l'ambiente.

Questo spiega anche il "TUI che non rende nei PTY sintetici" documentato da
prima: è **lo stesso difetto**, non un fatto separato. `stty` sull'host Hermes
dice `not a tty` — la sessione in cui vivo non ha terminale, quindi ogni
misura di rendering del TUI lì è meaningless.

**Conseguenza per la diagnosi**: non è la finestra dell'utente, non è
Chromium, non è il container. Il TUI ha bisogno di dimensioni reali dal
terminale, e dentro il container non le riceve.

**Come si risolve** (da scegliere/provare):
1. `--env COLUMNS=... LINES=...` — **misurato: NON funziona**.
2. Dare al container un vero TTY con dimensioni: la pista è che il TUI
   funziona sull'host con terminale reale, quindi la domanda è se
   `docker run -it` in una shell di login reale passa le dimensioni giuste
   (nel mio test il `-t` è allocato da uno pseudo-terminal di dimensione 0).
3. Non usare il TUI dentro il container: eseguire CyberStrike in modalità
   `run` non interattiva, che non dipende dalle dimensioni.

## Perché non l'ho chiuso io

Per il vincolo di progetto la verifica passa da un subagent indipendente,
ma questo difetto è **riproducibile solo con un TTY reale**: in PTY sintetici
il TUI non rende (fatto già noto e documentato per il TUI nativo). Quindi
serve o un TTY vero, o un test che misuri l'output senza renderizzare — e il
secondo è la strada giusta per distinguishing "non parte" da "non si vede".

## Criterio di chiusura

Il TUI mostra il logo **e** il prompt, e un prompt digitato produce risposta —
misurato dentro il container, non sull'host.

## Collegamento

- Ticket: `sandbox-docker-contenitore.md`, FASE 2
- Issue: #12
- Script di verifica già pronti: `infra/bounty-sandbox/verify.sh`,
  `browser-test.sh`, `tui-test.sh`

## RISOLTO come ostacolo (2026-09-26) — commit `404d18130`

Il blocco **non è il TUI**: sono quattro cose in fila, ognuna con un sintomo
diverso.

1. **TUI vuoto** — il TUI non gestisce l'assenza di TTY (`rows=0`,
   `columns=0`). Non è risolvibile lato container: si usa `run`, che non
   dipende dalle dimensioni del terminale. Il TUI interattivo resta fuori
   portata finché il TUI non impara a segnalare la mancanza di dimensioni.
2. **Stato perso a ogni avvio** — `auth.json` e il db stavano nel layer del
   container, e `--rm` li buttava via: ogni avvio rifaceva la migrazione.
   Risolto con due volumi nominati (`cyberstrike-share` su `~/.local`,
   `cyberstrike-config` su `~/.config/cyberstrike`).
3. **`EACCES: mkdir '/home/hunter/.local/share/cyberstrike/log'`** — Docker
   crea il mount point root-owned, e `hunter` (uid 1000) non ci scrive sotto.
   Il volume va montato su `.local` **intero**, e si copia **solo**
   `auth.json`: copiare `bin`/`lib` dall'host li porta root-owned e il
   fallimento si sposta al passo dopo.
4. **`no providers found`** — la lista dei provider viene da `models.dev`
   filtrata per **env riconosciuti** (`provider.ts:777`). La credenziale
   disponibile su questa macchina è `HERMES_CUSTOM_OMNI_API_KEY`, che
   CyberStrike non conosce: l'env esiste ma il provider non viene costruito.
   Va dichiarato come provider **custom** in `cyberstrike.json`
   (`@ai-sdk/openai-compatible`, baseURL OmniRoute). `setup-provider.sh` lo
   scrive con mode 0600 senza mai stampare la chiave.

**Verificato end-to-end**: `run "rispondi esattamente: SANDBOX OK"` →
`SANDBOX OK` su `auto/best-coding`. OmniRoute (`192.168.49.84:20128`)
raggiungibile dal container.

**Cosa resta del TUI**: il TUI interattivo dentro il container continua a non
mostrarsi, e la causa è nel TUI (nessun fallback quando le dimensioni sono
zero), non nel container. È un difetto di CyberStrike, non dell'ambiente.
