# /app in sola lettura — CHIUSO 2026-09-27

## Difetto
`run-sandbox.sh` montava il repository in `/app:rw`. Dentro quel mount ci sono
perimetro, tool e gate: i controlli stessi. Un processo nel container poteva
quindi disattivare i propri controlli e la sessione diventava auto-certificata.

Preesistente a questa modifica (gia' a `HEAD`), ma reale: verificato che una
scrittura in `packages/cyberstrike/src/index.ts` persisteva sul checkout
dell'host, cioe' il codice era mutabile per tutta la durata della sessione.

## Correzione
`-v "$REPO":/app:ro`.

`ro` non rompe nulla, misurato:
- `bb hunt --dry-run` completa: messaggio iniziale, perimetro, stato.
- il TUI parte (avviato in PTY con timeout, poi chiuso).
- tutto cio' che CyberStrike deve persistere gia' vive nei volumi
  (`cyberstrike-share`, `cyberstrike-config`, `cyberstrike-state`), non in /app.

## Verifica — `verify-v16-app-readonly.sh`
Due perimetri, perche' i due esiti non sono intercambiabili:
1. il codice NON si scrive (EROFS sui tre path) e l'host ne risponde
   (`git diff` pulito, nessun file nuovo);
2. `bb hunt` continua a funzionare — chiudere /app sarebbe inutile se in
   cambio il flusso smettesse di partire.

**Controprova:** con `/app:rw` il test va rosso e mostra i sorgenti
modificati. La controprova sporca davvero il checkout, quindi il test si
ripulisce da solo (`git checkout` dei due file): senza, eseguire la
controprova costa il repo. Misurato: è successo, ripulito a mano una volta.

## Difetto della mia prima verifica
Avevo copiato il launcher in `/tmp` per cambiare `:rw` in `:ro`. Ma `REPO` è
calcolato come `$HERE/../..`, quindi dalla copia in `/tmp` diventava `/` e il
bind di `/` finiva su `/app`: il mount non era applicato e il test concludeva
che `/app:ro` non funzionasse. Conclusione falsa, causata dalla mia prova, non
dal design. Il file di prova deve restare nella sua directory.

## Secondo difetto: commento che rompe la continuazione
Il commento che spiega il `:ro` l'avevo messo accanto al `-v`, dentro la
sequenza di `docker run` con `\`. Una riga commentata lì tronca la
continuazione e `docker run` riceve il solo `-v` come argomento
("requires at least 1 argument"). Il commento sta ora prima del `docker run`.
