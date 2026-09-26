#!/bin/bash
# FASE 2 — l'ambiente regge un agente BROWSER? Il bounty agent è un agente
# Playwright (hackbrowser/src/agent.ts, api.ts:151 fa preflight su
# chromium.executablePath()). Un container senza browser e' un agente muto.
set -u
FAIL=0
ok()  { echo "  ✅ $1"; }
bad() { echo "  ❌ $1"; FAIL=1; }

echo "=== Chromium installato? ==="
BIN=$(command -v chromium || command -v chromium-browser || command -v google-chrome)
if [ -n "$BIN" ]; then ok "browser: $BIN"; else bad "NESSUN browser — l'agente bounty non puo' funzionare"; exit 1; fi
"$BIN" --version 2>&1 | head -1

echo
echo "=== Il browser parte davvero (headless, dentro il container)? ==="
OUT=$(timeout 90 "$BIN" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
      --dump-dom about:blank 2>/tmp/chrome.err)
RC=$?
if [ $RC -eq 0 ] || echo "$OUT" | grep -qi "<html"; then
  ok "browser headless AVVIA e rende DOM"
else
  bad "browser non si avvia (rc=$RC)"; head -5 /tmp/chrome.err
fi

echo
echo "=== --no-sandbox serve davvero? (con drop ALL + no-new-privileges) ==="
# Se il sandbox di Chrome funziona, non serve --no-sandbox. Se NON funziona,
# lo scopriamo qui invece che a runtime con un crash generico.
if timeout 60 "$BIN" --headless --disable-gpu --disable-dev-shm-usage \
     --dump-dom about:blank >/dev/null 2>/tmp/nosbx.err; then
  ok "Chrome sandbox FUNZIONA (non serve --no-sandbox)"
else
  if grep -qi "namespace\|sandbox\|clone" /tmp/nosbx.err; then
    echo "  ⚠️  Chrome sandbox non avvia in questo container: serve --no-sandbox"
    echo "     $(head -2 /tmp/nosbx.err | tr '\n' ' ')"
  else
    echo "  ⚠️  sandbox non testabile per altra causa: $(head -2 /tmp/nosbx.err | tr '\n' ' ')"
  fi
fi

echo
echo "=== /dev/shm ==="
df -h /dev/shm 2>/dev/null | tail -1

echo
echo "=== Tool di hunting (ricontrollo dopo rebuild) ==="
for t in nmap curl python3 nc git rg jq; do
  command -v $t >/dev/null 2>&1 && ok "$t" || bad "$t ASSENTE"
done

echo
echo "=== Il volume dei programmi e' scrivibile? ==="
if touch /work/programmi/PROVA 2>/dev/null; then ok "vol /work scrivibile"; rm -f /work/programmi/PROVA
else bad "vol /work NON scrivibile"; fi

echo
[ $FAIL -eq 0 ] && echo "=== FASE 2 ENV: OK ===" || echo "=== FASE 2 ENV: PROBLEMI ==="
exit $FAIL
