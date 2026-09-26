#!/bin/bash
# Avvia CyberStrike DENTRO il container, con stato persistente.
#
# Il problema che questo risolve: senza volumi, `~/.local/share/cyberstrike`
# (auth.json + cyberstrike.db) sta nel layer del container e `--rm` lo BUTTA
# VIA a ogni avvio. Serviva rieseguire la migrazione e reinserire i provider.
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
PROGRAMS="${CYBERSTRIKE_HOME:-$HOME/.cyberstrike}/bugbounty/programs"
IMAGE="cyberstrike-bounty:sandbox"
NAME="cyberstrike-bounty"

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
if [ "${1:-}" = "run" ]; then
  shift
  ARGS=(run "$@")
elif [ -n "${1:-}" ]; then
  ARGS=("$@")
fi

# -t serve SOLO per il TUI. Misurato: dentro il container useTerminalDimensions()
# riceve rows=0/columns=0 e il TUI disegna una scena vuota senza errore. La
# modalita' `run` non dipende dalle dimensioni e funziona.
TTY_ARGS=()
if [ -n "${ARGS[*]:-}" ] || [ -n "${NO_TTY:-}" ]; then TTY_ARGS=(); else TTY_ARGS=(-it); fi

docker run "${TTY_ARGS[@]}" --rm --name "$NAME" \
  "${PASS_ENV[@]}" \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=1024 \
  --memory=3g \
  --shm-size=1g \
  --network bridge \
  -v "$REPO":/app:rw \
  -v "$PROGRAMS":/work/programmi:rw \
  -v "$HOME/.cyberstrike/bugbounty/cyberstrike.json":/app/cyberstrike.json:ro \
  -v "$VOL_SHARE":/home/hunter/.local:rw \
  -v "$VOL_CFG":/home/hunter/.config/cyberstrike:rw \
  -w /app \
  "$IMAGE" \
  /bin/bash -lc '
    cd /app
    [ -d node_modules ] || bun install --frozen-lockfile
    export CYBERSTRIKE_HOME=/work
    if [ -n "'"${ARGS[*]:-}"'" ]; then
      exec bun run --cwd packages/cyberstrike src/index.ts '"${ARGS[*]:-}"'
    else
      exec bun run dev
    fi'
