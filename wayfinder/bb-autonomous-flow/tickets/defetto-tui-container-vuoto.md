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

## Ipotesi, in ordine di probabilità — NON ANCORA VERIFICATA

1. **Dimensione del terminale.** Il TUI ha bisogno di un certo numero di
   righe/colonne; sotto quella soglia disegna una scena vuota. Da verificare
   con `stty size` **dentro** una sessione TTY reale (non misurabile da
   Hermes: `docker run -it` qui risponde `the input device is not a TTY`).
2. **`TERM` non impostato o sbagliato** dentro il container: senza un
   terminfo adeguato molte librerie TUI renderizzano il nulla invece di
   segnalare l'errore. Verificare con `echo $TERM` e provare
   `TERM=xterm-256color`.
3. **Il TUI scrive solo sequenze di posizionamento cursore** e senza un
   terminale che le interpreti resta 0 byte di testo visibile: è già
   confermato che 648 byte di ESC esistono, quindi la resa dipende
   dall'interprete del terminale, non dall'applicazione.

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
