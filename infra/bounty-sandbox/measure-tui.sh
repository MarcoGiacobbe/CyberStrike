#!/usr/bin/env bash
# Misura il difetto #14 sull'HOST, senza passare dal launcher Docker.
#
# Perche' qui e non nel container: il launcher ha un avvio lento (bun install,
# seed dei volumi) che maschera la finestra temporale che mi interessa — i
# 12+ secondi che il TUI ci mette per il primo render. Sull'host la misura parte
# subito, e il difetto #14 e' del TUI, non del mount.
#
# Il provider non e' l'oggetto della misura: se risponde 401 lo vediamo e lo
# separiamo, non lo confonderemo con lo schermo vuoto.
set -uo pipefail
cd "$(dirname "$0")/../../packages/cyberstrike" || exit 1

BUN="${BUN:-$HOME/.local/share/bun-1.3.9/bin/bun}"
OUT="${OUT:-/tmp/hunt-tui}"
SEND="${SEND:-rispondi esattamente: OK14}"
SEND_AFTER="${SEND_AFTER:-4}"
HOLD="${HOLD:-40}"
SETTLE="${SETTLE:-2}"

python3 ../../infra/bounty-sandbox/pty-drive.py \
  --cmd "TERM=xterm-256color $BUN run --conditions=browser ./src/index.ts" \
  --out "$OUT" --send "$SEND" \
  --send-after "$SEND_AFTER" --settle "$SETTLE" --hold "$HOLD"
rc=$?

echo "--- schermo ricostruito ---"
python3 ../../infra/bounty-sandbox/tui-screen.py "$OUT.raw" | tail -20
exit $rc
