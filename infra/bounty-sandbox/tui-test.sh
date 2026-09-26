#!/bin/bash
# Il TUI non rende in un PTY sintetico (fatto noto, vedi ticket V6/debug TUI).
# Quindi "non vedo output" NON significa "non parte". Qui si distingue:
#   - processo vivo che scrive su fd 1   → il TUI sta girando
#   - processo morto / nessun write      → l'avvio e' fallito
# Il file di log e' sul VOLUME, non nel layer: se scrive, scrive davvero.
set -u
cd /app

rm -f /work/programmi/_tui.log
timeout 40 bun run dev >/work/programmi/_tui.log 2>&1 &
PID=$!
sleep 25

echo "=== processo TUI vivo? ==="
if kill -0 $PID 2>/dev/null; then
  echo "  ✅ processo TUI ATTIVO (pid $PID) dopo 25s: l'avvio non e' fallito"
  echo "  processi figli:"; ps -ef | grep -E "cyberstrike|bun" | grep -v grep | head -5 | sed 's/^/     /'
else
  echo "  ❌ processo TUI gia' morto: avvio fallito"
fi

echo
echo "=== scrive su fd 1? (il TUI renderizza solo con un TTY) ==="
BYTES=$(stat -c%s /work/programmi/_tui.log 2>/dev/null || echo 0)
echo "  log: $BYTES byte"
if [ "$BYTES" -gt 0 ]; then
  echo "  ✅ il TUI ha prodotto output:"
  head -12 /work/programmi/_tui.log | sed 's/^/     /'
else
  echo "  ⚠️  0 byte: coerente con 'TUI non rende senza TTY' (noto, non e' un bug)"
fi

echo
echo "=== ci sono ERRORI nel log? (il vero segnale) ==="
if grep -qiE "error|cannot find|ENOENT|failed|panic" /work/programmi/_tui.log 2>/dev/null; then
  echo "  ❌ errori nell'avvio:"
  grep -iE "error|cannot find|ENOENT|failed|panic" /work/programmi/_tui.log | head -8 | sed 's/^/     /'
else
  echo "  ✅ nessun errore: l'avvio e' pulito"
fi

wait $PID 2>/dev/null
echo
echo "=== Dopo l'uscita naturale ==="
BYTES2=$(stat -c%s /work/programmi/_tui.log 2>/dev/null || echo 0)
echo "  log finale: $BYTES2 byte"
tail -8 /work/programmi/_tui.log 2>/dev/null | sed 's/^/     /'
rm -f /work/programmi/_tui.log
