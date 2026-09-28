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
# Container DEDICATO a questo test, con un nome suo. Senza, `--keep` riuserebbe
# (o sfreggerebbe contro) il container `cyberstrike-bounty` della caccia, che
# va lasciato intatto. E il trap qui sotto garantisce che il container venga
# INTERROTTO alla fine — riuso o no, riuscita o fallimento (regola del progetto:
# `--rm` non basta, lo stop deve essere esplicito).
KEEP_NAME="cyberstrike-v16-$$"
# Il riuso (`--keep`) funziona SOLO se il nome e' stabile fra le invocazioni
# dentro lo stesso test. Con `$$` nel nome ogni esecuzione del test ha un nome
# diverso e il riuso non puo' mai scattare: misurato, 3 invocazioni davano 3
# container. Il nome cambia a ogni ESECUZIONE del test, non a ogni invocazione
# interna: `$$` resta giusto per non collidere con altri test in parallelo, e
# le tre invocazioni di questo file condividono la stessa shell, quindi lo
# stesso `$$`.
export CYBERSTRIKE_SANDBOX_NAME="$KEEP_NAME"

# --- CLEANUP ---------------------------------------------------------------
# Misurato il 2026-09-28 (review avversariale + riproduzione): `trap cleanup
# TERM` NON basta — in bash il trap del chiamante non gira mentre un `docker
# exec` e' in foreground, e su SIGTERM il container restava vivo. Un watchdog
# in userspace NON e' una soluzione: uccidendo il padre questo resta zombie e
# `kill -0` continua a dire "vivo" (misurato), quindi il watchdog non spara.
# Nessun processo utente puo' garantire la pulizia dopo un SIGKILL.
#
# La leva che resta e' `docker stop`: uccide i processi DENTRO il container,
# indipendentemente da chi lo ha avviato. Per questo il container riusato non
# e' un `sleep infinity` muto, ma un ciclo che esce da solo se nessuno lo usa:
# vedi `KEEP_WATCHDOG_SEC` in run-sandbox.sh.
cleanup() { docker rm -f "$KEEP_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "=== V16: /app in sola lettura (programma=$PROG) ==="

AVAIL=$(free -m | awk 'NR==2{print $7}')
echo "  memoria libera: ${AVAIL} MB"
if [ "${AVAIL:-0}" -lt 2048 ]; then
  echo "  KO  memoria < 2 GB, non avvio"; exit 1
fi

FAIL=0

# --- 1. il codice deve essere NEGATO -------------------------------------
echo "-- test 1: scrittura nel codice NEGATA --"
out=$(timeout 180 bash "$HERE/run-sandbox.sh" --keep --program "$PROG" \
  test -c '
    for f in /app/PROVA_V16 /app/packages/cyberstrike/src/index.ts /app/packages/cyberstrike/package.json; do
      if echo SCRIVI >> "$f" 2>/dev/null; then echo "SCRITTO: $f"; else echo "NEGATO: $f"; fi
    done
  ' 2>&1)
rc=$?
echo "$out" | grep -E '^(SCRITTO|NEGATO):' | sed 's/^/  /'
# Il rc NON era controllato: catturato e mai usato. Un launcher che stampa le
# tre righe NEGATO e poi esce con 42 faceva passare il test. Un KO che esce 0
# o un crash che esce !=0 sono esiti diversi, quindi si richiede rc == 0
# E le tre righe attese.
if [ "$rc" -ne 0 ]; then
  echo "  KO  il launcher e' uscito con rc=$rc: il perimetro non e' stato provato"
  tail -3 <<<"$out" | sed 's/^/      /'
  FAIL=1
fi
if [ "$(grep -cE '^NEGATO:' <<<"$out")" -ne 3 ]; then
  echo "  KO  attesi 3 NEGATO, trovati $(grep -cE '^NEGATO:' <<<"$out"): la prova e' incompleta"
  FAIL=1
fi
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

# --- 1b. CONTROLLO POSITIVO: il probe sa scrivere? -------------------------
# Senza questo, V16 puo' essere verde perche' il probe e' semplicemente rotto
# o perche' il mount del programma e' sparito: "non ha scritto" e "non puo'
# scrivere" sono esiti diversi. Il revisore lo segnalò come difetto.
echo "-- test 1b: CONTROLLO POSITIVO, la scrittura DENTRO programs/$PROG funziona --"
outp=$(timeout 180 bash "$HERE/run-sandbox.sh" --keep --program "$PROG" \
  test -c '
    T=".v16-positivo-$$"
    D="/work/bugbounty/programs/'"$PROG"'"
    if echo POSITIVO-OK > "$D/$T" 2>/dev/null; then
      echo "POSITIVO: scritto dentro"; rm -f "$D/$T"
    else
      echo "POSITIVO: NEGATO, il tool non sa scrivere nella sua area"
    fi
  ' 2>&1)
rcp=$?
echo "$outp" | grep -E '^POSITIVO:' | sed 's/^/  /'
if [ "$rcp" -ne 0 ]; then echo "  KO  il launcher e' uscito con rc=$rcp"; FAIL=1; fi
if grep -q '^POSITIVO: scritto dentro' <<<"$outp"; then
  echo "  ok  il probe sa scrivere dove deve: il divieto di /app non e' un blocco totale"
else
  echo "  KO  CONTROLLO POSITIVO FALLITO: il test 1 non misura niente"
  tail -2 <<<"$outp" | sed 's/^/      /'
  FAIL=1
fi
echo

# --- 2. il flusso deve continuare a FUNZIONARE --------------------------
echo "-- test 2: bb hunt --dry-run funziona ancora (CONTROLLO DI REGRESSIONE) --"
o=$(timeout 250 bash "$HERE/run-sandbox.sh" --keep --program "$PROG" \
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
