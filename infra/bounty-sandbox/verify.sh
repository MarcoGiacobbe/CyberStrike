#!/bin/bash
# Verifica completa dell'ambiente, in tre passi, senza dover fidarsi sulla parola.
#
#   1) l'immagine e' quella giusta
#   2) l'ambiente regge (browser, tool, confine, volumi)
#   3) il TUI parte
#
# Uso:  ./verify.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IMAGE="cyberstrike-bounty:sandbox"
PROGRAMS="${CYBERSTRIKE_HOME:-$HOME/.cyberstrike}/bugbounty/programs"

echo "############ 1. IMMAGINE ############"
docker image inspect "$IMAGE" --format '  ✅ {{.RepoTags}} — {{.Size}} byte, creata {{.Created}}' 2>/dev/null \
  || { echo "  ❌ immagine $IMAGE assente: docker build -t $IMAGE $HERE"; exit 1; }

echo
echo "############ 2. AMBIENTE ############"
docker run --rm \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=1024 --memory=3g --shm-size=1g --network bridge \
  -v "$PROGRAMS":/work/programmi:rw \
  -v "$HERE":/sandbox:ro \
  --entrypoint /bin/bash "$IMAGE" /sandbox/browser-test.sh 2>&1 | grep -E "✅|❌|⚠️|===" | head -25

echo
echo "############ 3. TUI ############"
echo "  (qui dentro il TUI parte, ma non si puo' interagire: serve un TTY)"
echo "  → per la verifica completa esegui:  $HERE/run-sandbox.sh"
echo
echo "  avvio non interattivo (prova che il processo carica):"
timeout 120 docker run --rm \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=1024 --memory=3g --shm-size=1g \
  -v "$REPO":/app:rw \
  -v "$PROGRAMS":/work/programmi:rw \
  -w /app \
  --entrypoint /bin/bash "$IMAGE" -c \
  'bun --version && echo "--- avvio TUI (15s) ---" && timeout 15 bun run dev 2>&1 | head -20' 2>&1 | tail -25
echo
echo "  ⚠️  node_modules è 5.4G sull'host: se manca, installa DENTRO il container"
echo "     con  bun install  al primo avvio (il TUI può durare qualche minuto)."
