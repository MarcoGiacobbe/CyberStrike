#!/bin/bash
# V12 — verifica di chiusura: il flusso bug bounty funziona DAVVERO.
#
# Criterio (fissato prima, non dopo): sessione reale, messaggio inviato,
# risposta del provider RESA A SCHERMO, almeno un tool eseguito, perimetro
# rispettato. Se manca uno dei cinque, V12 non passa — e non si dichiara
# risolto perche' "ha prodotto byte".
#
# Una sola sessione per volta: nove sessioni in parallelo hanno saturato 14 GB
# e fatto terminare un'applicazione di sistema (2026-09-26).
set -uo pipefail

BUN="$HOME/.local/share/bun-1.3.9/bin/bun"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-/tmp/v12}"
MSG="${2:-rispondi esattamente: V12OK}"
# provider/model espliciti: il default (qwen-local-cyber) non e' in config ne'
# in auth.json, quindi non ha credenziali e non risponde mai.
MODEL="${3:-omni/auto/best-coding}"

echo "=== memoria PRIMA ==="
free -m | awk 'NR==2{print "  usata:", $3, "MB  disp:", $7, "MB"}'

residui=$(pgrep -f "conditions=browser" 2>/dev/null | wc -l)
if [ "$residui" -gt 0 ]; then
  echo "FALLITO: $residui processi TUI gia' attivi. Una sessione per volta."
  exit 1
fi

echo "=== V12: sessione reale, provider, un tool ==="
echo "  messaggio: $MSG"
echo "  provider:  $MODEL"

cd "$REPO/packages/cyberstrike"
# timeout SEMPRE: senza, il TUI resta vivo ~800 MB per sempre.
timeout 150 "$BUN" run --cwd . src/index.ts run -m "$MODEL" "$MSG" 2>&1 | tee "$OUT.log"

echo
echo "=== residui (deve essere 0) ==="
sleep 2
pgrep -f "conditions=browser" 2>/dev/null | wc -l

echo "=== memoria DOPO ==="
free -m | awk 'NR==2{print "  usata:", $3, "MB  disp:", $7, "MB"}'
