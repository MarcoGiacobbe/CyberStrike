# Ticket: il container perde i dati a ogni avvio

Stato: **APERTO (2026-09-26)** — 4 difetti misurati, 1 bloccante.
Issue GitHub: **#15**.

Segnalato dall'utente: *"Altro difetto. Ad ogni avvio del container perde i
dati!"*. Poi misurato.

## Difetto 1 — lo stato muore a ogni avvio (misurato)

Il comando di avvio manuale monta solo:

```
-v ~/hermes/cyberstrike-fork/CyberStrike:/app:rw
-v ~/.cyberstrike/bugbounty/programs:/work/programmi:rw
```

Nessun volume per `~/.local/share/cyberstrike`, che è dove vivono `auth.json`
e `cyberstrike.db`. Con `--rm` tutto muore.

Prova:

```
avvio 1: touch /home/hunter/.local/share/cyberstrike/MARKER.txt  → OK
avvio 2: cat  /home/hunter/.local/share/cyberstrike/MARKER.txt  → No such file or directory
```

`run-sandbox.sh` ha già i due volumi (`cyberstrike-share`,
`cyberstrike-config`) e risolve questo punto — ma il comando che l'utente usa
non li monta.

## Difetto 2 — `run-sandbox.sh` non accetta più comandi (misurato)

```
$ ./run-sandbox.sh bash -c '...'
Run 'docker run --help' for more information
```

Nel launcher:

```bash
elif [ -n "${1:-}" ]; then
  ARGS=("$@")          # ← tutto diventa argomento di CyberStrike
fi
...
exec bun run --cwd packages/cyberstrike src/index.ts "${ARGS[*]:-}"
```

Ogni argomento finisce in un comando CyberStrike, mai in bash. Lo script è
pensato per TUI e `run <messaggio>`, ma la sua intestazione lo documenta come
lancio generico — e `verify.sh` ed `e2e-test.sh` lo invocano aspettandosi una
shell. Quei due script non possono più funzionare così.

## Difetto 3 — i programmi sono invisibili al codice (misurato, bloccante)

`bounty-state.ts:113`:

```ts
return path.resolve(process.env["CYBERSTRIKE_HOME"] ?? path.join(os.homedir(), ".cyberstrike"))
```

e `programsDir()` = `<root>/bugbounty/programs/`.

Il container imposta `CYBERSTRIKE_HOME=/work` → il codice cerca
`/work/bugbounty/programs`. Ma il mount è su `/work/programmi`:

```
ls /work/bugbounty/programs  → No such file or directory
ls /work/programmi           → bcny-test
```

Tutti i programmi presenti sull'host — `bcny`, `bbtest`, `smoketest`,
`security`, `bookingcom` — sono **invisibili al codice dentro il container**.

Il perimetro e il gate di `stato-progetto` si ancorano a questa stessa base: se
la base è sbagliata, **gate e perimetro sono spenti in silenzio** (è la stessa
premessa che il commento di `root()` dichiara di voler evitare).

## Difetto 4 — lo stato bug bounty non è né scrivibile né persistente (misurato)

```
CYBERSTRIKE_HOME=/work
home reale        = /home/hunter
touch /work/MARKER → Permission denied
```

`/work` è root-owned nel layer del container, e non è un volume, quindi `--rm`
lo cancella. `/work` contiene anche `bin/`, non montata e quindi effimera.

## Soluzione proposta

1. **Un volume unico** `cyberstrike-state` per tutto ciò che deve sopravvivere,
   montato su `~/.local` e sulla radice bug bounty — invece di tre punti sparsi
   con permessi divergenti (è già la lezione del difetto EACCES già risolto:
   `.local` root-owned impediva `mkdir .local/state`).
2. `CYBERSTRIKE_HOME` che punta alla **directory che il codice calcola davvero**,
   cioè la radice che contiene `bugbounty/programs/`.
3. `run-sandbox.sh` con una sotto-modalità `shell`/`exec` che passa il comando
   a `/bin/bash` invece che a CyberStrike.
4. Permessi: volume inizializzato come `hunter` (1000:1000), mai root.
5. Sul lato dell'utente: `run-sandbox.sh` diventa l'unico modo consigliato di
   avviare, perché monta i volumi che il comando manuale non monta.

## Criterio di chiusura

- scrivere un file in ciascuna delle tre radici (`~/.local/share/cyberstrike`,
  `~/.config/cyberstrike`, radice bug bounty) → riavvio → **i tre file ci sono**
- un programma visibile dall'host è **visibile al codice** dentro il container,
  con lo stesso nome
- `./run-sandbox.sh shell -c 'comando'` esegue il comando e non lancia CyberStrike
- il gate di `stato-progetto` risulta **attivo** per un programma reale
  (`bounty_status` risponde, `todowrite` è bloccato) — è la prova che la base
  è quella giusta, non basta che `ls` funzioni

## Relazione con V6 e V12

Finché questo difetto è aperto, V6 (contenimento) e V12 (uso reale) restano
parziali: senza la base corretta non si può misurare nessuno dei due.
