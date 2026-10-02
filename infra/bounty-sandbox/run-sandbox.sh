#!/bin/bash
# Avvia CyberStrike DENTRO il container, con stato persistente.
#
# Il problema che questo risolve: senza volumi, `~/.local/share/cyberstrike`
# (auth.json + cyberstrike.db) sta nel layer del container e `--rm` lo BUTTA
# VIA a ogni avvio. Serviva rieseguire la migrazione e reinserire i provider.
#
# Nota sui path: i programmi sono montati in /work/bugbounty/programs e
# CYBERSTRIKE_HOME=/work, cosi' `bounty-state.root()` li trova dove li cerca
# senza trucchi. /work/programmi era il mount di prima, ma nessun codice ci
# guardava: i programmi risultavano inesistenti e, perche' il gate e il
# perimetro si ancorano alla stessa base, erano disattivati in silenzio.
#
# Uso:
#   ./run-sandbox.sh                    → menu TUI (nessun programma)
#   ./run-sandbox.sh --program bcny     → TUI limitato al programma bcny
#   ./run-sandbox.sh run "msg"          → modalita' non interattiva (NO TTY)
#   ./run-sandbox.sh test -c "cmd"      → comando di sistema
#   NO_TTY=1 ./run-sandbox.sh ...       → forzare senza TTY
#
# ISOLAMENTO FRA PROGRAMMI (2026-09-27, ticket fuga-laterale-fra-programmi):
# senza `--program`, la root del bug bounty NON e' montata: nel container non
# esiste nessun `credentials.json` e nessun config di altri programmi. Il
# perimetro software gia' copriva `programs/<programma>/`, ma il mount copriva
# tutta la root, quindi l'agente poteva leggere e riscrivere i segreti di ogni
# programma. Il perimetro dichiarava un confine che il mount non applicava.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
HOST_SHARE="$HOME/.local/share/cyberstrike"
# I volumi sono sovrascrivibili dall'esterno (`${VOL_CFG:-nome}`) perche' i
# test di verifica devono poter montare un volume usa-e-getta e ispezionare
# QUELLO, non un volume omonimo lasciato intatto: un controllo di integrita'
# fatto sul volume sbagliato certifica un volume che il test non ha toccato
# (difetto segnalato dal subagent deleg_cb90184f).
VOL_SHARE="${VOL_SHARE:-cyberstrike-share}"
VOL_CFG="${VOL_CFG:-cyberstrike-config}"
BB_ROOT="${CYBERSTRIKE_HOME:-$HOME/.cyberstrike}/bugbounty"   # config dei programmi + programs/
PROGRAMS="$BB_ROOT/programs"
IMAGE="cyberstrike-bounty:sandbox"
NAME="${CYBERSTRIKE_SANDBOX_NAME:-cyberstrike-bounty}"
PROGRAM="${CYBERSTRIKE_PROGRAM:-}"

# Il nome programma finisce dentro un path di mount, quindi va validato
# PRIMA di qualunque costruzione di path e prima di toccare docker. Senza
# questo controllo `--program ../../etc` trasformerebbe il "mount stretto" in
# un mount della root: esattamente la fuga che i mount stretti devono chiudere.
# Solo [a-z0-9_-]: mai '/' e mai '.'.
if [ -n "$PROGRAM" ]; then
  case "$PROGRAM" in
    *[!a-z0-9_-]* )
      echo "nome programma non valido: '$PROGRAM'" >&2
      echo "ammessi solo caratteri [a-z0-9_-] (niente '/' ne' '..' ne' maiuscole)" >&2
      exit 2 ;;
  esac
fi

# `bb hunt` risolve i config dalla root perché li conosce solo a runtime, ma il
# MOUNT deve essere costruito PRIMA di avviare il container. Quindi il
# programma è un argomento del launcher. Con mount stretti, `bb list` (che
# enumera i JSON della root) mostrerebbe solo il programma montato: dentro il
# container limitato l'elenco completo non è un dato disponibile, e va detto
# invece di fingere.
BB_MOUNTS=()
add_bb_mount() {   # add_bb_mount <host path> <container path> <ro|rw>
  [ -e "$1" ] || { echo "  ATTENZIONE: $1 non esiste, non montato" >&2; return 0; }
  BB_MOUNTS+=(-v "$1:$2:$3")
}

# I volumi nascono vuoti la prima volta: l'host ha gia' auth.json e il db, ma
# `cp` dentro un volume vuoto funziona. Si copia una volta sola e poi si lascia
# che il container aggiorni il db da solo (l'host NON deve piu' essere toccato,
# altrimenti si correggono a vicenda su due copie divergenti).
if ! docker volume inspect "$VOL_SHARE" >/dev/null 2>&1; then
  echo "prima esecuzione: creo i volumi e ci copio lo stato dall'host"
  docker volume create "$VOL_SHARE" >/dev/null
  docker volume create "$VOL_CFG" >/dev/null
  # Si copia SOLO `auth.json`. Tutto il resto (db, bin, lib, log) lo crea
  # l'app nel volume con i permessi giusti: copiare `bin`/`lib` dall'host li
  # porta root-owned e `mkdir log` fallisce con EACCES. Il db NON si copia:
  # due copie divergono e danno `no providers found`.
  docker run --rm -u 0 -v "$VOL_SHARE":/dst -v "$HOST_SHARE":/src:ro alpine \
    sh -c 'mkdir -p /dst/share/cyberstrike && cp /src/auth.json /dst/share/cyberstrike/auth.json && chown -R 1000:1000 /dst' >/dev/null
  docker run --rm -u 0 -v "$VOL_CFG":/dst -v "$HOME/.config/cyberstrike":/src:ro alpine \
    sh -c 'mkdir -p /dst && cp -a /src/. /dst/ 2>/dev/null; chown -R 1000:1000 /dst; true' >/dev/null
  echo "  ok"
fi

mkdir -p "$PROGRAMS"

# La config del provider "omni" va in ~/.config/cyberstrike/cyberstrike.json,
# non in /app: Global.Path.config = $XDG_CONFIG_HOME/cyberstrike
# (global/index.ts:10). Serve perche' HERMES_CUSTOM_OMNI_API_KEY non e' un nome
# che CyberStrike conosce — la lista dei provider viene da models.dev filtrata
# per chiavi riconosciute, quindi il provider va dichiarato a mano.
# Si applica a ogni avvio: il seed qui sotto gira solo se VOL_SHARE non esiste,
# e cyberstrike-config poteva esserci gia' senza il file (misurato: conteneva
# .gitignore e bun.lock di un'altra app, risultato "no providers found").
if [ -f "$HOME/.config/cyberstrike/cyberstrike.json" ]; then
  # Percorso CRITICO: Global.Path.config = $XDG_CONFIG_HOME/cyberstrike
  # (global/index.ts:10) e XDG_CONFIG_HOME=/home/hunter/csconfig, quindi il file
  # va in /dst/cyberstrike/cyberstrike.json. Scrivendolo in /dst/cyberstrike.json
  # il codice non lo vede: `no providers found`. Misurato 2026-10-02.
  # La subdirectory deve esistere gia' nel volume: il container monta VOL_CFG in
  # sola lettura, quindi se manca `mkdir` in Config fallisce con EROFS.
  docker run --rm -u 0 -v "$VOL_CFG":/dst -v "$HOME/.config/cyberstrike/cyberstrike.json":/src:ro alpine \
    sh -c 'mkdir -p /dst/cyberstrike && cp /src /dst/cyberstrike/cyberstrike.json && chown -R 1000:1000 /dst/cyberstrike && chmod 600 /dst/cyberstrike/cyberstrike.json' >/dev/null
fi

# I provider si costruiscono dagli ENV (provider.ts:777 `env: provider.env`),
# non dal db ne' da auth.json. Senza chiavi passate esplicitamente il container
# dice `no providers found`. Non si stampa il valore: solo il nome.
PASS_ENV=()
for k in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY \
         GOOGLE_GENERATIVE_AI_API_KEY GROQ_API_KEY MISTRAL_API_KEY \
         XAI_API_KEY DEEPSEEK_API_KEY OPENCODE_API_KEY; do
  [ -n "${!k:-}" ] && PASS_ENV+=(-e "$k")
done
# Le chiavi del provider "omni": hanno nomi che CyberStrike non conosce, ma sono
# l'unica credenziale disponibile su questa macchina. Si passano per env senza
# scriverle da nessuna parte.
[ -n "${HERMES_CUSTOM_OMNI_API_KEY:-}" ] && PASS_ENV+=(-e HERMES_CUSTOM_OMNI_API_KEY)
# NB: `compgen -v` elenca le variabili di SHELL, non quelle d'ambiente: usarlo
# per inoltrare env al container non funziona e fallisce in silenzio. Per questo
# i test passano quello che gli serve via stdin/STDERR, non via env.
echo "  env passati al container: ${#PASS_ENV[@]} (nomi: ${PASS_ENV[*]:-nessuno})"

ARGS=()
CS_CMD=""
MODE="tui"
# `--keep`: riusa il container esistente invece di avviarne uno nuovo. V14 e V16
# chiamano run-sandbox.sh 3 volte ciascuno: senza questo, 6 container di fila.
KEEP=0
# `PROGRAM` NON viene azzerato qui: riga 38 lo inizializza da
# `CYBERSTRIKE_PROGRAM`, e azzerarlo rendeva morta la variabile — il
# fallback era letto e poi scartato, quindi `CYBERSTRIKE_PROGRAM=bcny` senza
# `--program` avviava il container con ZERO mount pur stampando un perimetro.
# Misurato il 2026-09-27. Onorarla non indebolisce il confine: mount
# STRETTI sono la direzione restrittiva, e senza programma non se ne monta
# nessuno. Il nome arriva gia' validato dal controllo in cima.

# --keep riusa il container invece di avviarne uno nuovo. Senza questo, i test
# che chiamano run-sandbox.sh piu' volte (V14 e V16 lo fanno 3 volte ciascuno)
# avviano 6 container di fila: ~800MB di TUI ciascuno e il repo da 5.4GB
# rimontato ogni volta, per un risultato identico. Misurato il 2026-09-28.
# Il riuso e' esplicito e mai silenzioso: se il container esiste gia' ma con
# un programma DIVERSO, i mount non corrisponderebbero: si rifiuta invece di mentire.
while [ "${1:-}" = "--keep" ]; do
  shift || true
  KEEP=1
done

# --program va estratto PRIMA di interpretare il resto: il nome determina i
# mount. Il nome e' gia' stato validato in cima (subito dopo le variabili),
# prima di toccare docker.
while [ "${1:-}" = "--program" ] || [ "${1:-}" = "-p" ]; do
  shift || true
  PROGRAM="${1:-}"
  [ -n "$PROGRAM" ] || { echo "--program richiede un nome" >&2; exit 2; }
  case "$PROGRAM" in
    *[!a-z0-9_-]* )
      echo "nome programma non valido: '$PROGRAM'" >&2
      echo "ammessi solo caratteri [a-z0-9_-] (niente '/' ne' '..' ne' maiuscole)" >&2
      exit 2 ;;
  esac
  shift || true
done

# I mount del programma: la directory in scrittura (e' il progetto), il suo
# config in sola lettura. `credentials.json` NON viene montata, nemmeno in ro:
# il segreto che conta e' il contenuto, non la possibilita' di scriverlo. E la
# root intera non viene montata, altrimenti `bb list` continuerebbe a leggere i
# config di tutti i programmi — quindi non si puo' nemmeno accettare che
# leggere sia "solo lettura".
BB_DIR="$PROGRAMS/$PROGRAM"
if [ -n "$PROGRAM" ]; then
  # Il NOME e' gia' sicuro (solo [a-z0-9_-]), ma il PATH che ne nasce no:
  # `programs/<nome>` puo' essere un symlink verso una directory fuori da
  # programs/, e `docker -v` segue il link. Misurato il 2026-09-27: con
  # `programs/bcny -> /tmp/altrove` il segreto di /tmp/altrove era leggibile
  # dal container, e con `<nome>.json -> credentials.json` il contenuto delle
  # credenziali usciva dal mount "stretto" senza errori. Lo stesso per i tre
  # config del programma. La validazione del nome non copre questo: copre i
  # caratteri, non la DESTINAZIONE.
  # Percio' ogni path montato viene verificato due volte: non deve essere un
  # symlink, e una volta risolto deve restare dentro la sua base.
  # `docker -v` segue i symlink, quindi un path montato puo' arrivare a un
  # file o directory che non e' quello scritto. Regola applicata: nel flusso
  # bug bounty NESSUN symlink e' legittimo (la stessa scelta gia' presa per il
  # perimetro software in write/edit/apply_patch), quindi ogni path montato
  # deve essere un oggetto reale che risolve a se' stesso. Il controllo e' su
  # `-L`, non su `realpath`: `realpath` segue il link e restituirebbe
  # "va bene" perche' il bersaglio e' legittimo — ed e' proprio il caso da
  # rifiutare. Nessun symlink e' invece un uso legittimo che si perda.
  no_symlink() {   # no_symlink <path> <etichetta>
    if [ -L "$1" ]; then
      echo "RIFIUTO: $2 ($1) e' un symlink verso $(readlink -m "$1")." >&2
      echo "I path montati devono essere oggetti reali: un link lascia fuori"
      echo "dal perimetro quello che dovrebbe restare fuori." >&2
      exit 2
    fi
  }

  # Difesa in profondita': anche senza link, il path canonico deve restare
  # dentro la base. Copre i path con `..` e i link in un componente
  # intermedio, che `-L` sul path finale non vedrebbe.
  resolve_inside() {   # resolve_inside <base> <path>  -> 0 se il path resta dentro
    local base_real path_real
    base_real=$(realpath -m "$1" 2>/dev/null) || return 1
    path_real=$(realpath -m "$2" 2>/dev/null) || return 1
    case "$path_real" in
      "$base_real"/*) return 0 ;;
      *) return 1 ;;
    esac
  }

  mkdir -p "$BB_DIR"
  no_symlink "$BB_DIR" "la directory del programma"
  if ! resolve_inside "$PROGRAMS" "$BB_DIR"; then
    echo "RIFIUTO: $BB_DIR non e' dentro $PROGRAMS (path che esce da programs/)." >&2
    echo "Un programma deve essere una directory vera sotto programs/." >&2
    exit 2
  fi
  for f in "$PROGRAM.json" "$PROGRAM.accounts.json" "$PROGRAM.policy.md"; do
    src="$BB_ROOT/$f"
    [ -e "$src" ] || [ -L "$src" ] || continue
    no_symlink "$src" "il config del programma"
    if ! resolve_inside "$BB_ROOT" "$src"; then
      echo "RIFIUTO: $src non e' dentro $BB_ROOT (path che esce dalla root)." >&2
      echo "Un config di programma deve essere un file vero nella root bugbounty." >&2
      exit 2
    fi
  done
  add_bb_mount "$BB_DIR"       "/work/bugbounty/programs/$PROGRAM" rw
  # Il path del programma VISTO DALL AGENTE dentro il container. Va passato
  # come env, non interpolato nella stringa interna (stessa ragione di
  # CS_CMD): qui $PROGRAM e gia valorizzato, e dichiararlo piu in alto
  # produceva silenziosamente il path senza handle (misurato: /work/
  # bugbounty/programs/ invece di .../bcny, e il perimetro avrebbe incluso
  # TUTTI i programmi invece del solo bcny).
  CS_PROGRAM_DIR="/work/bugbounty/programs/$PROGRAM"
  add_bb_mount "$BB_ROOT/$PROGRAM.json"        "/work/bugbounty/$PROGRAM.json"        ro
  add_bb_mount "$BB_ROOT/$PROGRAM.accounts.json" "/work/bugbounty/$PROGRAM.accounts.json" ro
  # La policy va montata DENTRO programs/<programma>, non alla radice di
  # /work/bugbounty. Motivo, misurato: --perimeter e programs/<programma>,
  # quindi una policy alla radice e' fuori dal perimetro e l'agente la
  # legge come NEGATA. E AGENTS.md la indica per nome: se il file e' li' ma
  # irraggiungibile, l'agente si ferma su un divieto che non ha mai letto.
  #
  # Montata ro, non copiata: la copia dentro programs/ la renderebbe
  # scrivibile (directory rw) e l'agente potrebbe riscrivere il proprio
  # contratto dopo averlo letto.
  #
  # Il mount-point deve gia' esistere nella directory rw. `touch`, NON
  # `mkdir`: montare un file sopra una directory fallisce con
  # "not a directory".
  #
  # La sorgente e' `programs/<programma>/<programma>.policy.md`, NON la copia
    # nella root di bugbounty: `bb sync` scrive solo li' (sync.ts) e la copia
    # root non e' piu' prodotta.
    #
    # Perche' il path legacy era un difetto — MISURATO, e non come sembrava:
    # il launcher montava `$BB_ROOT/$PROGRAM.policy.md`, il percorso legacy,
    # SOPRA il percorso nuovo. Ho *assunto* che significasse "l'agente legge
    # una policy obsoleta". Ho lanciato il launcher a HEAD per controllarlo:
    # la copia root era gia' stata rimossa, quindi `add_bb_mount` ha saltato
    # il mount e l'agente ha letto benissimo il file annidato. Il caso legacy
    # era quindi NON fatale da solo.
    #
    # Il difetto vero era un altro, e piu' subdolo: mountando la copia root,
    # il launcher *nascondeva* il file annidato con un bind mount. Se la copia
    # root fosse ricomparsa (ce n'e' stata una, storicamente), l'agente avrebbe
    # letto quella, e con `bb sync` che aggiorna solo la copia annidata le due
    # sarebbero divergute in silenzio. Sorgente unica = niente divergenza.
    # Il caso "file assente" e' benigno perche' `add_bb_mount` salta il mount e
    # resta il file vero della directory rw.
    #
    # Resta pero' vero che `touch` crea un placeholder VUOTO sull'host: per
    # questo `bb-program-docs.ts` controlla `stat().size > 0`, non
    # `existsSync`, altrimenti AGENTS.md annuncerebbe un file di zero byte.
  touch "$BB_DIR/$PROGRAM.policy.md"
  add_bb_mount "$BB_DIR/$PROGRAM.policy.md"    "/work/bugbounty/programs/$PROGRAM/$PROGRAM.policy.md" ro
  echo "  programma: $PROGRAM (mount: programs/$PROGRAM rw, config ro)"
  echo "  verificato: i path montati sono realmente dentro programs/ (nessun symlink)"
  echo "  NON montati: credentials.json, altri programmi, root BB_ROOT"
else
  echo "  nessun programma: BB_ROOT non montata"
  echo "  dentro il container NON esiste credentials.json ne' alcun config di programma"
fi

# `bb hunt <programma>` e' un SOTTOCOMANDO della CLI, non un messaggio all'agente.
# Senza questo ramo finiva in `... run "$CS_CMD"`, cioe' dentro una sessione LLM
# che leggeva il sorgente invece di eseguire il comando: la riga
# `=== MESSAGGIO INIZIALE ===` del --dry-run non stampava MAI, e il fallimento
# sembrava del perimetro quando era un errore di invocazione. Misurato 2026-09-27.
if [ "${1:-}" = "bb" ]; then
  shift
  MODE="bb"
  CS_CMD="$*"
elif [ "${1:-}" = "run" ]; then
  shift
  MODE="cyberstrike"
  CS_CMD="$*"
elif [ "${1:-}" = "shell" ]; then
  shift
  if [ "${1:-}" = "-c" ]; then
    shift
    MODE="test"
    CS_CMD="$*"
  else
    MODE="shell"
  fi
elif [ "${1:-}" = "test" ] || [ "${1:-}" = "bash" ]; then
  shift
  MODE="test"
  if [ "${1:-}" = "-c" ]; then shift; fi
  CS_CMD="$*"
elif [ -n "${1:-}" ]; then
  # Non e' un difetto: qualunque argomento non riconosciuto e' un MESSAGGIO per
  # CyberStrike, non un comando shell. `run-sandbox.sh "cerca subdomini di X"`
  # deve parlare con l'agente. I comandi di sistema vanno con `test` / `shell -c`.
  MODE="cyberstrike"
  CS_CMD="$*"
fi

# `bb` (senza sotto-comando) e' il TUI, quindi non va passato a yargs: va
# eseguito il TUI. `bb hunt ...` invece e' un vero sottocomando e va passato
# INTERO. Il caso quindi ricostruisce il comando esatto invece di concatenarlo.
if [ "$MODE" = "bb" ]; then
  CS_CMD="bb${CS_CMD:+ $CS_CMD}"
fi

# -t serve SOLO per il TUI. Misurato: dentro il container useTerminalDimensions()
# riceve rows=0/columns=0 e il TUI disegna una scena vuota senza errore. La
# modalita' `run` non dipende dalle dimensioni e funziona.
TTY_ARGS=()
case "$MODE" in
  tui)         TTY_ARGS=(-it) ;;
  shell)       TTY_ARGS=(-it) ;;
  cyberstrike) TTY_ARGS=(); [ -n "${FORCE_TTY:-}" ] && TTY_ARGS=(-it) ;;
  # `bb hunt` col TUI ha bisogno di TTY; il `--dry-run` no. `-it` fallisce con
  # "the input device is not a TTY" quando lo stdin non e' un terminale (test,
  # CI, cron), quindi si degrada a non interattivo: il dry-run resta eseguibile
  # e il TUI fallira' con un errore chiaro invece di mascherarsi.
  bb)          if [ -t 0 ]; then TTY_ARGS=(-it); else TTY_ARGS=(); fi ;;
  test)        TTY_ARGS=() ;;
esac

# /app e' il CODICE (perimetro, tool, gate) e va in sola lettura: se
# l'agente puo' scriverci, puo' disattivare i propri controlli e la sessione
# diventa auto-certificata. Misurato il 2026-09-27: con `rw` una scrittura
# in packages/cyberstrike/src/index.ts persistava sul checkout dell'host.
# `ro` non rompe nulla: misurato che `bb hunt --dry-run` completa (messaggio,
# perimetro, stato) e che il TUI parte. Tutto cio' che CyberStrike deve
# persistere gia' vive nei volumi (share, config, state), non in /app.
# NB: il commento sta QUI e non accanto al `-v` perche' una riga commentata
# dentro una sequenza con `\` tronca la continuazione e `docker run` riceve
# il solo `-v` come argomento ("requires at least 1 argument").

# --- RIUSO DEL CONTAINER (--keep) -----------------------------------------
# Problema misurato il 2026-09-28: V14 e V16 chiamano questo script 3 volte
# ciascuno. Ogni chiamata avviava un `docker run` da zero: 6 container di fila,
# ~800MB di TUI ciascuno, con il repo da 5.4GB rimontato ogni volta, per
# arrivare allo stesso risultato. Il costo e' stato pagato, il beneficio no.
#
# Con `--keep` il container viene avviato UNA volta, detached e vivo, e ogni
# invocazione successiva entra con `docker exec`. Stessi mount, stesso
# comando, stesso risultato: cambia solo quanto costa arrivarci.
# La stringa interna usa il segnaposto `@@CS_CMD@@` al posto di `$CS_CMD`:
# dentro single quote `$CS_CMD` resterebbe LETTERALE (il ramo `test` eseguirebbe
# una variabile vuota e il comando non girerebbe — misurato il 2026-09-28).
# Il segnaposto viene sostituito in un secondo momento, quando il valore e'
# noto: cosi' il quoting non si annida e resta leggibile.
INNER_SCRIPT='cd /app
    [ -d node_modules ] || bun install --frozen-lockfile
    export CYBERSTRIKE_HOME=/work
    case "@@MODE@@" in
      test)        exec /bin/bash -c "$CS_CMD" ;;
      shell)       exec /bin/bash ;;
      # Il flag perimeter non e cosmetico. Senza il confine applicativo
      # `run` ha solo question: deny: il perimetro vive nei MOUNT del
      # container, quindi l-agente aveva un disco confinato ma nessuna
      # regola nei tool. Il disco limita i file, non le azioni.
      #
      # --dir e --perimeter vanno insieme: il primo mette l-agente davanti ai
      # dati di caccia, il secondo gli impedisce di uscirne.
      #
      # `--dir` da solo crashava con "no providers found". La causa NON era la
      # cwd: `run --dir /app`, cioe la STESSA directory di default, crashava
      # uguale. Era il seed della config, che scriveva in
      # VOL_CFG/cyberstrike.json mentre il codice cerca
      # $XDG_CONFIG_HOME/cyberstrike/cyberstrike.json (global/index.ts:10) —
      # un livello di troppo. Finora non si notava perche a cwd=/app la config
      # veniva recuperata da findUp sul cyberstrike.json del repo (:ro).
      # Corretto piu in alto, in questo stesso file.
      #
      # NOTA: niente apostrofi in questi commenti. INNER_SCRIPT e una
      # stringa single-quoted: un apostrofo la chiude e lo script si rompe
      # con errore di sintassi (misurato tre volte).
      # CS_AUTO abilita il flag --auto di `run`: auto-approva i permessi in
      # `ask` (simula un operatore che dice sempre si) lasciando i `deny` del
      # perimetro intatti. Va accettato esplicitamente da chi lancia: da solo
      # --auto significa via libera a bash, quindi e una scelta dell operatore.
      #
      # NOTA: niente apostrofi in questi commenti. INNER_SCRIPT e una
      # stringa single-quoted: un apostrofo la chiude e lo script si rompe.
      # Con un apostrofo in "e una scelta dell operatore" la stringa si
      # chiudeva a meta e bash eseguiva `una` come comando: exit 127,
      # "riga 366: una: comando non trovato" (misurato 2026-10-02).
      # `bash -n` NON lo intercetta: non espande le variabili.
      cyberstrike) exec bun run --cwd packages/cyberstrike src/index.ts run "$CS_CMD" \
                          --dir "$CS_PROGRAM_DIR" --perimeter "$CS_PROGRAM_DIR" \
                          ${CS_AUTO:+--auto} ;;
      bb)          exec bun run --cwd packages/cyberstrike src/index.ts $CS_CMD ;;
      tui)         exec bun run dev ;;
    esac'
# Solo `@@MODE@@` viene sostituito qui. `CS_CMD` NON viene interpolato nella
# stringa: arriva al container come variabile d'ambiente (`-e CS_CMD`) e li'
# viene letto con `"$CS_CMD"`. La sostituzione testuale era una trappola:
# in `${var//pat/rep}` il `&` dentro `rep` significa "tutto cio' che ha
# matched pat", quindi un comando con `&&` diventava
# `@@CS_CMD@@@@CS_CMD@@` e i `&&` sparivano; con `2>/dev/null` il
# `>&` veniva mangiato e il comando eseguito era diverso da quello scritto
# (misurato il 2026-09-28, due volte: prima sparivano gli `&&`, poi i `&` dei
# redirect). L'env evita l'intera classe di problemi.
INNER_SCRIPT=${INNER_SCRIPT//@@MODE@@/$MODE}

if [ "$KEEP" = "1" ]; then
  # CONTROLO 1 — il container esiste ed e' eseguibile. Riusare un container
  # fermo o rotto produrrebbe un test che sembra passare e non misura nulla.
  if [ -n "$(docker ps -q --filter "name=^/${NAME}$")" ]; then
    if ! docker exec "$NAME" true 2>/dev/null; then
      echo "RIFIUTO: '$NAME' esiste ma non e' eseguibile. Rimuovilo: docker rm -f $NAME" >&2
      exit 2
    fi
    # CONTROLO 2 — i mount sono scelti all'avvio e NON cambiano con `exec`.
    # Un container avviato per un programma diverso darebbe un verde bugiardo.
    # La fonte di verita' sono i mount reali del container, non un file: un
    # file di marcatore nella directory del programma verrebbe scritto
    # dall'host (sporcando il programma dell'utente) e potrebbe essere
    # assente o obsoleto. `docker inspect` non mente su cosa e' montato.
    #
    # NB: vanno controllate SORGENTE *E* DESTINAZIONE. Controllando solo la
    # destinazione, un container montato da una directory arbitraria con lo
    # stesso nome di programma passava il controllo e il test leggeva il
    # contenuto sbagliato (`WRONG_SOURCE`) con rc=0. Misurato il 2026-09-28
    # dalla review avversariale e riprodotto.
    if [ -n "$PROGRAM" ]; then
      _want_src="$BB_ROOT/programs/$PROGRAM"
      if ! docker inspect -f '{{range .Mounts}}{{println .Source " " .Destination}}{{end}}' "$NAME" 2>/dev/null \
           | awk -v s="$_want_src" -v d="/work/bugbounty/programs/$PROGRAM" \
                 '$1==s && $2==d { found=1 } END { exit !found }'; then
        echo "RIFIUTO: '$NAME' NON ha il mount $BB_ROOT/programs/$PROGRAM" >&2
        echo "        (i mount sono scelti all'avvio e non cambiano con exec):" >&2
        docker inspect -f '{{range .Mounts}}{{println "          " .Source " -> " .Destination}}{{end}}' "$NAME" 2>/dev/null >&2
        echo "        Ripulisci e riavvia:  docker rm -f $NAME" >&2
        exit 2
      fi
    elif ! docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$NAME" 2>/dev/null \
           | grep -qx '/work/bugbounty/programs'; then
      # Senza `--program` il montaggio del perimetro non e' verificabile, ma
      # il container non deve comunque prestare i suoi mount a una sessione
      # che non li ha chiesti. Misurato il 2026-09-28: senza `--program` il
      # controllo non girava affatto e veniva letto comunque il contenuto
      # del programma montato.
      echo "RIFIUTO: '$NAME' e' riusato senza --program: i suoi mount non sono" >&2
      echo "        quelli della sessione richiesta. Riavvia con --program." >&2
      exit 2
    fi
    # Azzera il contatore di inattivita' del container riusato: senza questo
    # il ciclo di auto-terminazione lo ucciderebbe a meta' di un test lento.
    # Se il touch fallisce, il file NON viene aggiornato: e' la direzione
    # sicura, perche' un container che muore e' ricostruibile, mentre un
    # marker falso lo lascerebbe vivo per sempre.
    docker exec -i "$NAME" sh -c ': > /tmp/.keep-alive' 2>/dev/null || true
    exec docker exec -i \
      ${TTY_ARGS[@]+"${TTY_ARGS[@]}"} \
      -e CS_CMD="$CS_CMD" \
  -e CS_PROGRAM_DIR="$CS_PROGRAM_DIR" \
  -e CS_AUTO="${CS_AUTO:-}" \
      "$NAME" /bin/bash -lc "$INNER_SCRIPT"
  fi
  # Non esiste (o e' fermo): si rimuove e si avvia pulito, UNA volta sola.
  # Poi si entra SUBITO con `exec` per eseguire il comando: `docker run -d`
  # avvia e ritorna subito, quindi senza questa seconda invocazione il
  # comando non girerebbe mai e il test would dire "PASS" senza aver
  # misurato niente (misurato il 2026-09-28: output vuoto, solo l'hash del
  # container restituito da `docker run`).
  docker rm -f "$NAME" >/dev/null 2>&1 || true
fi

# Con --keep il container sopravvive: resta vivo con `sleep infinity` e le
# invocazioni successive ci entrano con `exec`. Senza, `--rm` lo butta a ogni
# avvio, ed e' il comportamento normale di caccia.
if [ "$KEEP" = "1" ]; then
  RUN_FLAGS=(-d)
  # Il container riusato non e' un `sleep infinity` muto: e' un ciclo che
  # esce da SOLO se nessuno lo usa da `KEEP_IDLE_SEC` secondi. Motivo
  # (misurato il 2026-09-28): nessun trap e nessun watchdog in userspace
  # garantisce la rimozione di un container se chi lo ha avviato viene
  # ucciso con SIGKILL — il padre resta zombie e `kill -0` mente. Con
  # l'auto-terminazione, anche l'interruzione piu' brutala lascia il
  # container vivo per AL PIU' `KEEP_IDLE_SEC`, poi muore da solo.
  #
  # Il contatore di inattivita' e' un file in /tmp del container: ogni `exec`
  # di questo script lo azzera. Se nessuno lo tocca per KEEP_IDLE_SEC, il
  # ciclo esce. Non usa `date` per non dipendere dal clock del container.
  KEEP_CMD='exec /bin/bash -lc '"'"'
    MARK=/tmp/.keep-alive
    : > "$MARK"
    while true; do
      sleep 5
      now=$(date +%s)
      last=$(stat -c %Y "$MARK" 2>/dev/null || echo 0)
      [ $(( now - last )) -ge 900 ] && exit 0
    done
  '"'"''
  KEEP_IDLE_SEC=900
  # `docker run -d -t` e' rifiutato dal daemon. In `--keep` un TTY non serve:
  # il comando gira con `docker exec -i`. Meglio dirlo che lasciarlo fallire
  # con un errore di docker che sembrerebbe un problema del perimetro.
  if [ -n "${TTY_ARGS[*]:-}" ]; then
    echo "RIFIUTO: --keep non e' compatibile con una modalita' TTY ($MODE)." >&2
    echo "        Con --keep il comando gira in background e si entra con exec." >&2
    exit 2
  fi
else
  RUN_FLAGS=(--rm)
  KEEP_CMD="$INNER_SCRIPT"
fi

# V17: la configurazione del container e' montata in SOLA LETTURA (piu' sotto,
# `csconfig:ro`). Dentro quel volume c'e' solo `cyberstrike.json` — il provider
# e il modello. Nessuna credenziale, e `credentials.json` non e' montata.
#
# Perche' chiuderla. Il perimetro di scrittura dell'agente e' applicativo
# (ruleset + gate dei tool), quindi vale per i path che i tool riescono a
# ispezionare: `rm -rf /tmp/x`, `echo > /etc/x`, `curl -o` vengono negati. Un
# comando NON ispezionabile (`python3 -c "open(...)"`, `bash -c '...'`) passa
# invece dal canale dell'utente, e un "sempre" lo rende permanente. Qui la
# scrittura e' negata dal kernel: non e' una promessa dello strumento, e' il
# filesystem. Il volume persiste fra un avvio e l'altro, quindi una modifica
# sopravviverebbe alla sessione e cambierebbe il comportamento della
# successiva — esattamente il danno che il perimetro promette di non poter
# causare.
#
# `bb hunt` continua a funzionare. `global/index.ts:30` esegue
# `fs.mkdir(Global.Path.config, { recursive: true })`, cioe' `mkdir -p`, e la
# sottodirectory `cyberstrike` esiste gia' nel volume: misurato, `mkdir -p` su
# una directory gia' esistente NON lancia nemmeno in sola lettura (rc=0). Senza
# `-p` lancerebbe EEXIST e l'avvio morirebbe dentro `Promise.all`, che non
# cattura. Il test end-to-end di `bb hunt` in verify-v17-config-readonly.sh
# copre questa riga: se il percorso cambiasse, diventerebbe rosso.
docker run "${TTY_ARGS[@]}" "${RUN_FLAGS[@]}" --name "$NAME" \
  "${PASS_ENV[@]}" \
  -e CS_CMD="$CS_CMD" \
  -e CS_PROGRAM_DIR="$CS_PROGRAM_DIR" \
  -e CS_AUTO="${CS_AUTO:-}" \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=1024 \
  --memory=2g \
  --shm-size=1g \
  --network bridge \
  -v "$REPO":/app:ro \
  ${BB_MOUNTS[@]+"${BB_MOUNTS[@]}"} \
  -v "$VOL_SHARE":/home/hunter/csdata:rw \
  -v "$VOL_CFG":/home/hunter/csconfig:ro \
  -e HOME=/home/hunter \
  -e XDG_CONFIG_HOME=/home/hunter/csconfig \
  -e XDG_DATA_HOME=/home/hunter/csdata \
  -e XDG_CACHE_HOME=/home/hunter/csdata/cache \
  -e XDG_STATE_HOME=/home/hunter/csdata/state \
  -w /app \
  "$IMAGE" \
  /bin/bash -lc "$KEEP_CMD"
rc_run=$?

# --- $HOME/.config CREATA DA DOCKER COME ROOT ---------------------------------
# Misurato il 2026-09-28: `docker run -v VOL_CFG:/home/hunter/.config/cyberstrike`
# fa creare a DOCKER i padri mancanti, e li crea come ROOT (uid 0):
#     drwxr-xr-x 3 0 0 4096 /home/hunter/.config
# mentre il container gira come `hunter` (uid 1000):
#     mkdir: cannot create directory '/home/hunter/.config/prova': Permission denied
# Conseguenza reale: Chromium andava in crash con rc=133 e in stderr
# `chrome_crashpad_handler: --database is required`, perche' crashpad non
# riusciva a scrivere il suo database in `$HOME/.config`. Sembrava un problema
# di browser, era un problema di permessi creato dal mount.
#
# `chown` NON e' una strada: con `--cap-drop=ALL` si ottiene
#     chown: changing ownership of '/home/hunter/.config': Operation not permitted
# neanche da `docker exec -u 0` (misurato). Percio' le XDG sopra puntano
# dentro `$HOME` gia' esistente e gia' di proprieta' di `hunter`, dove
# l'utente puo' scrivere, e il path del volume resta quello che il codice si
# aspetta. xdg-basedir rispetta XDG_CONFIG_HOME/XDG_DATA_HOME, quindi
# Global.Path.config punta dove deve.
#
# Nota: il guard in stealth.ts (mkdir -p $HOME/.config) resta utile ma da solo
# non basta: su una directory root-owned fallisce con EACCES.

# `docker run` senza --keep e' il percorso normale: il comando e' gia' eseguito
# e il suo exit code e' quello della sessione.
[ "$KEEP" = "1" ] || exit "$rc_run"

# --- --keep: il container e' avviato e vivo, il comando non e' ancora partito.
# Il `docker run -d` qui sopra ha solo acceso il container (con `sleep
# infinity`): senza questo `exec` il comando non verrebbe mai eseguito e chi
# chiama qui sotto riceverebbe un successo fasullo. Misurato il 2026-09-28.
exec docker exec -i \
  -e CS_CMD="$CS_CMD" \
  -e CS_PROGRAM_DIR="$CS_PROGRAM_DIR" \
  -e CS_AUTO="${CS_AUTO:-}" \
  "$NAME" /bin/bash -lc "$INNER_SCRIPT"
