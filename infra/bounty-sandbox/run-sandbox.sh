#!/bin/bash
# Avvia CyberStrike DENTRO il container, con stato persistente e percorsi che il
# codice riconosce.
#
# I QUATTRO difetti che questo risolve (tutti misurati il 2026-09-26, vedi
# wayfinder/bb-autonomous-flow/tickets/difetto-persistenza-stato.md):
#
#  1. Lo stato moriva a ogni avvio. Il comando manuale montava solo /app e
#     /work/programmi: `~/.local/share/cyberstrike` (auth.json + cyberstrike.db)
#     stava nel layer e `--rm` lo buttava via. Prova: avvio 1 scrive un file,
#     avvio 2 risponde "No such file or directory".
#
#  2. I PROGRAMMI ERANO INVISIBILI AL CODICE. `bounty-state.ts:110` fa
#     `path.resolve($CYBERSTRIKE_HOME ?? ~/.cyberstrike)` e i programmi stanno
#     in `<root>/bugbounty/programs/`. Con CYBERSTRIKE_HOME=/work il codice
#     cercava `/work/bugbounty/programs`, ma il mount era su `/work/programmi`:
#     "No such file or directory", e bcny/bbtest/smoketest/security/bookingcom
#     risultavano inesistenti. Peggio: il gate di stato-progetto e il perimetro
#     si ancorano alla STESSA base, quindi erano spenti in silenzio.
#
#     La soluzione non è un trucco sui path ma l'opposto: la base giusta
#     (`~/.cyberstrike`) contiene già `bugbounty/programs/`, quindi basta
#     montare la home dell'host su quella directory e NON impostare
#     CYBERSTRIKE_HOME. Il codice calcola il percorso che già gli serve e
#     funziona senza sapere nulla del container.
#
#  3. `/work` era root-owned e non era un volume: `touch /work/MARKER` dava
#     "Permission denied" e `--rm` lo cancellava. Risolto togliendo `/work` dal
#     percorso delle scritture: tutta la stato dell'agente sta sotto
#     /home/hunter, che è l'unica directory scrivibile e persistente. `/work`
#     esiste solo nell'immagine, e non ci si scrive.
#     (Un symlink su /work non è una strada: su un mount Docker non si può
#     sostituire una directory con un symlink — `ln -sfnT` dà "cannot overwrite
#     directory" e senza -T crea il link dentro, "Permission denied". Misurato.)
#
#  4. Questo script non accettava comandi: ogni argomento finiva in un comando
#     CyberStrike, mai in bash. `./run-sandbox.sh bash -c '...'` produceva
#     `Run 'docker run --help' for more information`. E `verify.sh` ed
#     `e2e-test.sh` lo invocano aspettandosi una shell.
#
# Uso:
#   ./run-sandbox.sh                 -> TUI interattivo
#   ./run-sandbox.sh run "messaggio"  -> modalita' non interattiva
#   ./run-sandbox.sh shell            -> shell interattiva nel container
#   ./run-sandbox.sh shell -c 'cmd'   -> esegue cmd nel container
#   ./run-sandbox.sh test -c 'cmd'    -> esegue cmd senza aprire il TUI
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IMAGE="${CYBERSTRIKE_SANDBOX_IMAGE:-cyberstrike-bounty:sandbox}"
NAME="${CYBERSTRIKE_SANDBOX_NAME:-cyberstrike-bounty}"

# Radice dei dati bug bounty SULL'HOST. È la base che `bounty-state.root()`
# calcola per già, quindi dentro il container finisce nello stesso posto e i
# programmi sono visibili al codice senza trucchi sui path.
HOST_HOME="${CYBERSTRIKE_HOME:-$HOME/.cyberstrike}"
VOL_STATE="cyberstrike-state"    # ~/.cyberstrike (programmi, stato, config)
VOL_SHARE="cyberstrike-share"    # ~/.local       (auth.json, database)
VOL_CFG="cyberstrike-config"      # ~/.config/cyberstrike (config provider)
SORGENTI="$HOST_HOME/bugbounty/sorgenti"   # montato ro in /home/hunter/sorgenti

mkdir -p "$HOST_HOME/bugbounty/programs" "$SORGENTI"

# La config del provider custom ("omni") sta in ~/.config/cyberstrike/cyberstrike.json
# — NON nella home bug bounty: `Global.Path.config` = `$XDG_CONFIG_HOME/cyberstrike`
# (global/index.ts:10). L'ho prima messa nel posto sbagliato e l'app rispondeva
# "no providers found". Serve perche' `HERMES_CUSTOM_OMNI_API_KEY` non e' un nome
# che CyberStrike conosce: la lista dei provider viene da models.dev filtrata per
# chiavi riconosciute, quindi il provider va dichiarato a mano.
HOST_CFG="$HOME/.config/cyberstrike"
if [ ! -f "$HOST_CFG/cyberstrike.json" ]; then
  echo "ATTENZIONE: manca $HOST_CFG/cyberstrike.json — esce 'no providers found'."
fi

# I volumi nascono vuoti la prima volta. Si inizializzano come l'utente
# `hunter` (1000:1000): copiarli dall'host come root li porta root-owned dentro,
# ed è già successo (EACCES su mkdir .local/state, poi su mkdir log).
if ! docker volume inspect "$VOL_STATE" >/dev/null 2>&1; then
  echo "prima esecuzione: creo i volumi e li inizializzo come hunter (1000:1000)"
  docker volume create "$VOL_STATE" >/dev/null
  docker volume create "$VOL_SHARE" >/dev/null
  docker volume create "$VOL_CFG" >/dev/null
  # `auth.json` si copia una volta sola: è l'unica credenziale che l'host ha già
  # e che il container non può ricreare. Il database NON si copia: due copie
  # divergono e danno "no providers found" — lo crea l'app dentro il volume.
  HOST_SHARE="$HOME/.local/share/cyberstrike"
  if [ -f "$HOST_SHARE/auth.json" ]; then
    docker run --rm -u 0 -v "$VOL_SHARE":/dst -v "$HOST_SHARE":/src:ro alpine \
      sh -c 'mkdir -p /dst/share/cyberstrike && cp /src/auth.json /dst/share/cyberstrike/auth.json && chown -R 1000:1000 /dst' >/dev/null
  fi
  # La home bug bounty si copia dall'host perché i programmi (bcny, bbtest,
  # security, …) sono già lì e devono essere visibili al codice.
  docker run --rm -u 0 -v "$VOL_STATE":/dst -v "$HOST_HOME":/src:ro alpine \
    sh -c 'mkdir -p /dst/bugbounty/programs /dst/bugbounty/sorgenti && cp -a /src/. /dst/ && chown -R 1000:1000 /dst' >/dev/null
  echo "  ok"
fi

# La config del provider la applico a OGNI avvio, non solo al primo: il volume
# `cyberstrike-config` era gia' stato creato da un'altra app (conteneva
# .gitignore e bun.lock), quindi il seed lo saltava e cyberstrike.json non
# arrivava mai nel container. Misurato il 2026-09-26: "no providers found".
if [ -d "$HOST_CFG" ] && [ -f "$HOST_CFG/cyberstrike.json" ]; then
  docker run --rm -u 0 -v "$VOL_CFG":/dst -v "$HOST_CFG":/src:ro alpine \
    sh -c 'mkdir -p /dst && cp /src/cyberstrike.json /dst/cyberstrike.json && chown 1000:1000 /dst/cyberstrike.json && chmod 600 /dst/cyberstrike.json' >/dev/null
fi

# I provider si costruiscono dagli ENV (`env: provider.env` in provider.ts), non
# dal db né da auth.json: senza chiavi riconosciute l'app dice
# "no providers found". Si passa il NOME, mai il valore.
PASS_ENV=()
for k in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY \
         GOOGLE_GENERATIVE_AI_API_KEY GROQ_API_KEY MISTRAL_API_KEY \
         XAI_API_KEY DEEPSEEK_API_KEY OPENCODE_API_KEY; do
  [ -n "${!k:-}" ] && PASS_ENV+=(-e "$k")
done
# Le chiavi del provider "omni" hanno nomi che CyberStrike non conosce, ma sono
# l'unica credenziale disponibile su questa macchina.
[ -n "${HERMES_CUSTOM_OMNI_API_KEY:-}" ] && PASS_ENV+=(-e HERMES_CUSTOM_OMNI_API_KEY)

# --- modalità di invocazione --------------------------------------------------
# tui = TUI CyberStrike; cyberstrike = `run` non interattivo; shell = bash.
MODE="tui"
case "${1:-}" in
  run)   MODE="cyberstrike"; shift; CS_CMD="$*" ;;
  shell) MODE="shell"; shift ;;
  test)  MODE="shell-notty"; shift; [ "${1:-}" = "-c" ] && { shift; CS_CMD="$*"; MODE="test-cmd"; } ;;
  "")    ;;
  *)     MODE="shell-notty"; shift; CS_CMD="$*" ;;
esac

# `-t` serve solo al TUI e alla shell interattiva: senza un terminale
# `useTerminalDimensions()` non ha dimensioni. `run` non ne ha bisogno.
TTY_ARGS=()
case "$MODE" in
  tui)         TTY_ARGS=(-it) ;;
  shell)       TTY_ARGS=(-it) ;;
  shell-notty) TTY_ARGS=() ;;
  cyberstrike) TTY_ARGS=(); [ -n "${FORCE_TTY:-}" ] && TTY_ARGS=(-it) ;;
esac

# CYBERSTRIKE_HOME NON viene impostato: la home del container (/home/hunter)
# contiene già `.cyberstrike`, ed è esattamente il default che il codice usa
# quando la variabile manca. Impostarla a /work era la causa del difetto 2.
PRELUDE=$(cat <<'EOS'
set -e
cd /app
[ -d node_modules ] || bun install --frozen-lockfile
echo "root() risolve in: /home/hunter/.cyberstrike (CYBERSTRIKE_HOME non impostato: e' il default del codice)"
echo "programmi visibili: $(ls -1 /home/hunter/.cyberstrike/bugbounty/programs 2>/dev/null | tr '\n' ' ')"
echo "sorgenti (ro): $(ls -1 /home/hunter/sorgenti 2>/dev/null | wc -l) file"
EOS
)

case "$MODE" in
  tui)         TAIL='exec bun run dev' ;;
  cyberstrike) TAIL='exec bun run --cwd packages/cyberstrike src/index.ts run "$CS_CMD"' ;;
  shell)       TAIL='exec /bin/bash' ;;
  test-cmd)     TAIL='exec /bin/bash -c "$CS_CMD"' ;;
  shell-notty)  TAIL='exec /bin/bash -c "$CS_CMD"' ;;
esac

exec docker run "${TTY_ARGS[@]}" --rm --name "$NAME" \
  "${PASS_ENV[@]}" \
  -e CS_CMD="${CS_CMD:-}" \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=1024 \
  --memory=3g \
  --shm-size=1g \
  --network bridge \
  -v "$REPO":/app:rw \
  -v "$VOL_STATE":/home/hunter/.cyberstrike:rw \
  -v "$VOL_SHARE":/home/hunter/.local:rw \
  -v "$VOL_CFG":/home/hunter/.config/cyberstrike:rw \
  -v "$SORGENTI":/home/hunter/sorgenti:ro \
  -w /app \
  "$IMAGE" \
  /bin/bash -lc "$PRELUDE"$'\n'"$TAIL"
