# Ticket: il container perde i dati a ogni avvio

Stato: **RISOLTO (2026-09-26)** — 4 difetti chiusi in `run-sandbox.sh`, verifica indipendente in corso.
Issue GitHub: **#15**.

## Come si avvia adesso

```bash
./infra/bounty-sandbox/run-sandbox.sh shell    # bash interattivo
./infra/bounty-sandbox/run-sandbox.sh tui      # il TUI CyberStrike (MUST)
./infra/bounty-sandbox/run-sandbox.sh run "messaggio"   # non interattivo
./infra/bounty-sandbox/run-sandbox.sh test -c 'cmd'     # un comando
```

Non usare più il `docker run` manuale: monta `/app:rw` (l'agente può scrivere in
tutto il repo), usa `--rm` senza volumi, e punta i programmi a `/work/programmi`
mentre il codice li cerca in `~/.cyberstrike/bugbounty/programs`.

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


## Risoluzione (2026-09-26) — correzione minima, non rifacimento

Ho sbagliato il modo: avevo rifatto l'ambiente del container (nuovi volumi,
`/work/.cyberstrike`, `sorgenti` separato). L'utente: *"Solo cyberstrike è dentro
docker. Tutto il resto uguale a prima!"*. Il sandbox è CyberStrike in Docker —
non un ambiente parallelo. Quindi la versione di prima di `run-sandbox.sh` è
stata ripristinata e corretti **quattro difetti, uno alla volta**, lasciando
volumi, `/work`, `CYBERSTRIKE_HOME` e provider come erano.

| # | Difetto | Comune | Com'è chiuso |
|---|---|---|---|
| 1 | lo stato moriva a ogni avvio | `docker run --rm` senza volumi di stato | **invariato** — i due volumi `cyberstrike-share` e `cyberstrike-config` c'erano già e restano |
| 2 | i programmi erano invisibili al codice | `CYBERSTRIKE_HOME=/work` → il codice cerca `<root>/bugbounty/programs/`, il mount era su `/work/programmi` | **un solo path**: il mount va su `/work/bugbounty/programs`. Nessun trucco, nessuna variabile cambiata |
| 3 | `test -c 'cmd'` non eseguiva | ogni argomento finiva come messaggio CyberStrike | il comando viaggia per env (`CS_CMD`), non interpolato nella stringa di shell |
| 4 | la config provider non veniva letta | era montata su `/app/cyberstrike.json` | `Global.Path.config` = `$XDG_CONFIG_HOME/cyberstrike` (`global/index.ts:10`), quindi va nel volume `cyberstrike-config`, applicata **a ogni avvio** |

Sul difetto 2 la cosa da capire è che **il perimetro e il gate erano spenti in
silenzio**: si ancorano alla stessa base di `bounty-state.root()`, quindi se il
codice cerca in `/work/bugbounty/programs` e il mount è su `/work/programmi`,
entrambi continuano a funzionare e non si accorgono che il progetto non esiste.
Nessun errore, nessun avviso — solo un agente senza perimetro.

### Errori miei lungo la strada

1. **`ln -sfn /home/hunter/.cyberstrike /work`** — su un mount Docker non si può
   sostituire una directory con un symlink: `ln -sfnT` dà `cannot overwrite
   directory`, e senza `-T` crea il link *dentro* `/work`. Risolto togliendo
   `/work` dal percorso delle scritture invece di spostarlo.
2. **`printf '%q '`** dentro `/bin/bash -lc` — `%q` è una bash-ism che `sh` non
   gestisce, e dentro `$( )` con quoting annidato rompe il parser.
3. **Config nel posto sbagliato due volte**: prima in `~/.cyberstrike/bugbounty/`,
   poi su `/app/`. CyberStrike la legge solo in `~/.config/cyberstrike/`
   (`global/index.ts:10`, precedenza #2 in `config.ts:71-78`).
4. **Il seed dei volumi gira solo se `VOL_SHARE` non esiste** (`if ! docker
   volume inspect`), ma `cyberstrike-config` poteva esserci già senza il file
   provider. Per questo ora la config è applicata a ogni avvio, se l'host ce
   l'ha.

## Criteri di chiusura — misurati

| Criterio | Come | Esito |
|---|---|---|
| il codice vede i programmi | `BountyState.root()`, `programsDir()`, `directory()` | `root()=/work`, `programsDir=/work/bugbounty/programs`, programmi presenti |
| il perimetro si arma | `ProjectPerimeter.buildProjectRuleset()` | 9 regole, `deny external_directory` presente |
| `test -c` esegue | `run-sandbox.sh test -c '…'` | eseguito in bash |
| il provider risponde | `run "rispondi esattamente: …"` | in verifica |
| i file sopravvivono al riavvio | marker in 3 radici, riavvio, `test -e` | 2/3 sopravvivono — vedi sotto |
| il provider risponde | `run "rispondi esattamente: MINIMO OK"` | `MINIMO OK` — passa |

**Il terzo marker è `Permission denied`, e non è un difetto residuo.** `/work`
stesso è root-owned nel layer dell'immagine, quindi `hunter` non ci scrive: solo
`/work/bugbounty/programs/` (che è il mount) è scrivibile, ed è l'unica
directory dove il codice scrive. Lo stato dell'agente sta tutto sotto
`/home/hunter` e i programmi sotto il mount: entrambi sopravvivono, misurato.

Vale la pena notare cosa non ho fatto: potrei aver montato anche `/work`
stesso come volume e risolvere anche quello, ma significherebbe un quarto
volume e un pezzo di logica in più per una directory in cui nessuno scrive.

Verifica indipendente: in corso.


## Verifica indipendente — primo giro (subagent avversariale)

Il subagent ha verificato una versione **superata** di `run-sandbox.sh` (quella
in cui avevo rifatto l'ambiente, poi respinta dall'utente). Il suo esito non conta
come verifica di questa. Comunque i suoi quattro difetti extra sono stati
riprovați **uno per uno** sulla versione attuale, e due erano reali:

| Difetto segnalato | Sulla versione attuale |
|---|---|
| `~/.config` root-owned, `EACCES` | **vero ma innocuo**: `drwxr-xr-x root root` su `~/.config`, ma `~/.config/cyberstrike` è `hunter:hunter` e **dentro il volume si scrive** — misurato. È l'unica dir che CyberStrike usa sotto XDG_CONFIG |
| `shift` nel fallback `*)` scarta il primo argomento | **non riprodotto**: `run-sandbox.sh echo hello` → `hello`. Il difetto era della versione rifatta |
| `shell -c` rotto (`the input device is not a TTY`) | **vero** — documentato in testata, non funzionante: la clausola ignorava `-c` e imponeva `-it`. **Corretto**: con `-c` diventa non-TTY |
| `test` senza `-c` esegue a vuoto | **non riprodotto**: `run-sandbox.sh test ls` esegue `ls` e stampa il contenuto |

Correzione: `shell -c 'cmd'` ora esegue il comando (`SHELL-C OK`); `shell` senza
`-c` resta la shell interattiva con `-it`.
