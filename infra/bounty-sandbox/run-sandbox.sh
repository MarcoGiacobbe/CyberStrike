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
#   ./run-sandbox.sh              → menu TUI (se il TUI funziona)
#   ./run-sandbox.sh run "msg"    → modalita' non interattiva (N0 TTY)
#   NO_TTY=1 ./run-sandbox.sh ... → forzare senza TTY
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
HOST_SHARE="$HOME/.local/share/cyberstrike"
VOL_SHARE="cyberstrike-share"
VOL_CFG="cyberstrike-config"
BB_ROOT="${CYBERSTRIKE_HOME:-$HOME/.cyberstrike}/bugbounty"   # config dei programmi + programs/
PROGRAMS="$BB_ROOT/programs"
IMAGE="cyberstrike-bounty:sandbox"
NAME="${CYBERSTRIKE_SANDBOX_NAME:-cyberstrike-bounty}"

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
  docker run --rm -u 0 -v "$VOL_CFG":/dst -v "$HOME/.config/cyberstrike/cyberstrike.json":/src:ro alpine \
    sh -c 'mkdir -p /dst && cp /src /dst/cyberstrike.json && chown 1000:1000 /dst/cyberstrike.json && chmod 600 /dst/cyberstrike.json' >/dev/null
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
echo "  env passati al container: ${#PASS_ENV[@]} (nomi: ${PASS_ENV[*]:-nessuno})"

ARGS=()
CS_CMD=""
MODE="tui"
if [ "${1:-}" = "run" ]; then
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

# -t serve SOLO per il TUI. Misurato: dentro il container useTerminalDimensions()
# riceve rows=0/columns=0 e il TUI disegna una scena vuota senza errore. La
# modalita' `run` non dipende dalle dimensioni e funziona.
TTY_ARGS=()
case "$MODE" in
  tui)         TTY_ARGS=(-it) ;;
  shell)       TTY_ARGS=(-it) ;;
  cyberstrike) TTY_ARGS=(); [ -n "${FORCE_TTY:-}" ] && TTY_ARGS=(-it) ;;
  test)        TTY_ARGS=() ;;
esac

docker run "${TTY_ARGS[@]}" --rm --name "$NAME" \
  "${PASS_ENV[@]}" \
  -e CS_CMD="$CS_CMD" \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=1024 \
  --memory=2g \
  --shm-size=1g \
  --network bridge \
  -v "$REPO":/app:rw \
  -v "$BB_ROOT":/work/bugbounty:rw \
  -v "$VOL_SHARE":/home/hunter/.local:rw \
  -v "$VOL_CFG":/home/hunter/.config/cyberstrike:rw \
  -w /app \
  "$IMAGE" \
  /bin/bash -lc '
    cd /app
    [ -d node_modules ] || bun install --frozen-lockfile
    export CYBERSTRIKE_HOME=/work
    case "'"$MODE"'" in
      test)        exec /bin/bash -c "$CS_CMD" ;;
      shell)       exec /bin/bash ;;
      cyberstrike) exec bun run --cwd packages/cyberstrike src/index.ts run "$CS_CMD" ;;
      tui)         exec bun run dev ;;
    esac'
