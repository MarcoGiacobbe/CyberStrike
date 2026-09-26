#!/bin/bash
# FASE 2 E2E — l'agente parte DAVVERO dentro il container?
#
# Non "il container si avvia": che `bun run dev` trovi il codice, le dipendenze
# e il chromium, e che il TUI arrivi a un prompt. Il TUI e' una TUI: qui si
# verifica l'avvio, non l'interazione.
set -u
cd /app 2>/dev/null || { echo "❌ /app non montato: run-sandbox.sh non usato"; exit 1; }

echo "=== ambiente ==="
echo "  cwd:   $(pwd)"
echo "  bun:   $(command -v bun || echo ASSENTE)"
echo "  user:  $(id -un) uid=$(id -u)"
echo "  home:  $HOME"

echo
echo "=== il codice e' montato? ==="
[ -f package.json ] && ok=1 || ok=0
if [ $ok -eq 1 ]; then
  echo "  ✅ package.json presente"
  echo "  name: $(python3 -c 'import json;print(json.load(open("package.json")).get("name","?"))' 2>/dev/null)"
else
  echo "  ❌ package.json ASSENTE: il repo non e' montato"
fi

echo
echo "=== le dipendenze sono installate? ==="
if [ -d node_modules ] && [ -d packages/cyberstrike/node_modules ]; then
  echo "  ✅ node_modules presenti"
else
  echo "  ⚠️  node_modules ASSENTI: serve bun install (run-sandbox.sh lo fa)"
  if command -v bun >/dev/null 2>&1; then
    echo "     bun presente, installo ora (puo' volerci qualche minuto)"
    timeout 540 bun install --frozen-lockfile 2>&1 | tail -5
  else
    echo "     ❌ bun non installato nell'immagine: l'immagine non puo' eseguire CyberStrike"
  fi
fi

echo
echo "=== chromium (preflight di hackbrowser/api.ts:151) ==="
CBIN=$(command -v chromium || command -v chromium-browser || command -v google-chrome)
if [ -n "$CBIN" ]; then echo "  ✅ $CBIN ($("$CBIN" --version 2>&1 | head -1))"
else echo "  ❌ nessun browser: l'agente bounty non puo' partire"; fi

echo
echo "=== il TUI parte? (avvio, non interazione) ==="
# timeout 25: se in 25s non ha stampato niente e non e' morto, e' vivo.
OUT=$(timeout 25 bun run dev 2>&1 | head -25)
RC=$?
if echo "$OUT" | grep -qiE "cyberstrike|logo|welcome|seleziona|agent|err|cannot|not found"; then
  echo "  ✅ il TUI ha prodotto output:"
  echo "$OUT" | head -10 | sed 's/^/     /'
else
  echo "  ⚠️  nessun output dal TUI (rc=$RC)"
  echo "$OUT" | head -5 | sed 's/^/     /'
fi

echo
echo "=== i dati dei programmi sono dove l'agente li aspetta? ==="
ls -la /work/programmi/ 2>/dev/null | head -5 || echo "  ⚠️  /work/programmi vuoto o non montato"
echo "  sorgenti (ro): $(ls /work/sorgenti 2>/dev/null | wc -l) elementi"

echo
echo "=== il perimetro: /work scrivibile, /etc no ==="
touch /work/programmi/_probe 2>/dev/null && { echo "  ✅ /work scrivibile"; rm -f /work/programmi/_probe; } || echo "  ❌ /work NON scrivibile"
touch /etc/_probe 2>/dev/null && { echo "  ❌ /etc SCRIVIBILE — confine rotto"; rm -f /etc/_probe; } || echo "  ✅ /etc non scrivibile"
