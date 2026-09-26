#!/bin/bash
# Lancia CyberStrike DENTRO il container bounty.
#
#   ./run-sandbox.sh                    → TUI interattivo
#   ./run-sandbox.sh run "messaggio"     → run non interattivo
#   ./run-sandbox.sh tui                 → TUI esplicito
#
# Il repo e' montato in /app: e' il codice, NON i dati del programma. I dati
# stanno in /work (host: ~/.cyberstrike/bugbounty). Tenere i due separati e'
# quello che rende il volume dei programmi rimontabile senza toccare il codice.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROGRAMS="${CYBERSTRIKE_HOME:-$HOME/.cyberstrike}/bugbounty/programs"
IMAGE="cyberstrike-bounty:sandbox"
NAME="cyberstrike-bounty"

# Il codice dentro il container: i sorgenti del programma, NON il repo. Un
# git clone del target non deve stare in /work (sarebbe dentro il perimetro di
# scrittura, che va tenuto pulito per i soli artefatti dell'hunting).
SOURCES="${SOURCES:-$PROGRAMS}"

mkdir -p "$PROGRAMS" "$SOURCES"

MODE="${1:-tui}"; shift || true

# --cap-add=NET_RAW NON basta da solo per nmap -sS: serve anche root (misurato,
# vedi ticket fase 1.3). Restiamo senza raw socket e usiamo `nmap -sT`.
# Se serve la SYN scan: aggiungi --user root --cap-add=NET_RAW.
docker run -it --rm --name "$NAME" \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=1024 \
  --memory=3g \
  --shm-size=1g \
  --network bridge \
  -v "$REPO":/app:rw \
  -v "$PROGRAMS":/work/programmi:rw \
  -v "$SOURCES":/work/sorgenti:ro \
  -v "$HOME/.config":/home/hunter/.config:rw \
  -w /app \
  "$IMAGE" \
  /bin/bash -lc "$BUN_BIN install --frozen-lockfile 2>/dev/null || true; \
    export PLAYWRIGHT_CHROMIUM_ARGS='--no-sandbox --disable-dev-shm-usage'; \
    bun run dev ${MODE:+--} ${MODE} $*"
