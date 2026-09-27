#!/bin/bash
# V16 — il codice dell'agente non e' scrivibile dall'agente (/app in ro).
#
# Il difetto: `run-sandbox.sh` montava il repository in /app:rw. Dentro quel
# mount ci sono perimetro, tool e gate, cioe' i controlli stessi. Un processo
# nel container poteva quindi disattivare i propri controlli e la sessione
# diventava auto-certificata. Preesistente a questa modifica (gia' a HEAD),
# ma reale: verificato che una scrittura in src/index.ts persisteva sul
# checkout dell'host.
#
# Il perimetro qua e' doppio e serve perche' i due esiti sono diversi:
#   1. il codice NON si scrive           -> EROFS
#   2. `bb hunt` continua a FUNZIONARE   -> messaggio, perimetro, stato
# Il secondo e' il vero rischio di questa modifica: chiudere /app e' inutile
# se in cambio `bb hunt` smette di partire. Un test che verifica solo il
# punto 1 passerebbe anche avendo rotto tutto.
#
# Controprova: con /app:rw questo test deve diventare rosso.

HERE="$(cd "$(dirname "$0")" && pwd)"
PROG="${1:-bcny}"
REPO="$(cd "$HERE/../.." && pwd)"

echo "=== V16: /app in sola lettura (programma=$PROG) ==="

AVAIL=$(free -m | awk 'NR==2{print $7}')
echo "  memoria libera: ${AVAIL} MB"
if [ "${AVAIL:-0}" -lt 2048 ]; then
  echo "  KO  memoria < 2 GB, non avvio"; exit 1
fi

FAIL=0

# --- 1. il codice deve essere NEGATO -------------------------------------
echo "-- test 1: scrittura nel codice NEGATA --"
out=$(timeout 180 bash "$HERE/run-sandbox.sh" --program "$PROG" \
  test -c '
    for f in /app/PROVA_V16 /app/packages/cyberstrike/src/index.ts /app/packages/cyberstrike/package.json; do
      if echo SCRIVI >> "$f" 2>/dev/null; then echo "SCRITTO: $f"; else echo "NEGATO: $f"; fi
    done
  ' 2>&1)
rc=$?
echo "$out" | grep -E '^(SCRITTO|NEGATO):' | sed 's/^/  /'
if ! grep -qE '^(SCRITTO|NEGATO):' <<<"$out"; then
  echo "  KO  il container non ha girato: il test non misura niente"
  tail -3 <<<"$out" | sed 's/^/      /'
  FAIL=1
fi
if grep -q '^SCRITTO:' <<<"$out"; then
  echo "  KO  il codice e' SCRIVIBILE: $(grep -m1 '^SCRITTO:' <<<"$out")"
  FAIL=1
else
  echo "  ok  nessun file di codice scritto"
fi
# la prova piu' forte: il file devo essere assente SULL'HOST. Il container
# potrebbe mentire sul proprio errore; l'host non puo'.
if compgen -G "$REPO/PROVA_V16" >/dev/null; then
  echo "  KO  PROVA_V16 e' comparso sul checkout dell'host"
  rm -f "$REPO/PROVA_V16"; FAIL=1
else
  echo "  ok  nessun file nuovo sul checkout dell'host"
fi
# NB: con /app:rw questo test MODIFICA davvero i sorgenti dell'host (e' il
# punto della controprova). Se non si ripulisce, chi lo esegue si ritrova il
# checkout sporcato con due righe `SCRIVI` in index.ts e package.json. Quindi
# la pulizia e' parte del test, non un extra: senza, la controprova costa il
# repo. Misurato: e' successo, ripulito a mano.
if ! git -C "$REPO" diff --quiet -- packages/cyberstrike/src/index.ts packages/cyberstrike/package.json 2>/dev/null; then
  echo "  KO  il sorgente e' MODIFICATO nel checkout:"
  git -C "$REPO" diff --stat -- packages/cyberstrike/src/index.ts packages/cyberstrike/package.json | sed 's/^/      /'
  git -C "$REPO" checkout -- packages/cyberstrike/src/index.ts packages/cyberstrike/package.json 2>/dev/null
  echo "      (ripristinati: la scrittura era dell'attacco, non del lavoro in corso)"
  FAIL=1
else
  echo "  ok  i sorgenti sono identici a HEAD"
fi

# --- 2. il flusso deve continuare a FUNZIONARE --------------------------
echo "-- test 2: bb hunt --dry-run funziona ancora (CONTROLLO DI REGRESSIONE) --"
o=$(timeout 250 bash "$HERE/run-sandbox.sh" --program "$PROG" \
  bb hunt "$PROG" --dry-run 2>&1)
if grep -q "=== MESSAGGIO INIZIALE ===" <<<"$o" \
   && grep -q "=== PERIMETRO ===" <<<"$o" \
   && grep -q "=== STATO ===" <<<"$o"; then
  echo "  ok  messaggio iniziale, perimetro e stato tutti presenti"
  grep -A2 "=== PERIMETRO ===" <<<"$o" | grep 'directory progetto' | sed 's/^/  /'
else
  echo "  KO  bb hunt non completa col perimetro (regressione funzionale)"
  tail -6 <<<"$o" | sed 's/^/      /'
  FAIL=1
fi
if grep -qE 'Read-only file system|EROFS' <<<"$o"; then
  echo "  KO  bb hunt ha toccato /app in scrittura e si e' rotto"
  FAIL=1
else
  echo "  ok  nessun errore di filesystem read-only nel flusso"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "V16: PASS — codice non scrivibile e bb hunt ancora funzionante"
else
  echo "V16: FAIL — vedi i KO sopra"
fi
exit $FAIL
