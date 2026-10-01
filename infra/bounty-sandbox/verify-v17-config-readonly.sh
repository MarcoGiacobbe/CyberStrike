#!/bin/bash
# V17 — la configurazione del container non e' scrivibile dall'agente (csconfig:ro).
#
# Il difetto: `run-sandbox.sh` montava `VOL_CFG` in `rw`. Il perimetro di
# scrittura dell'agente e' APPLICATIVO (ruleset + gate dei tool): vale per i
# path che i tool riescono a ispezionare, e li nega. Ma un comando non
# ispezionabile (`python3 -c "open('/x','w')"`, `bash -c '...'`) passa dal
# canale dell'utente, e se l'utente risponde "sempre" la scrittura avviene.
# Il volume persiste fra un avvio e l'altro: una modifica sopravvive alla
# sessione e cambia il comportamento della successiva.
#
# Perche' questo volume e non un altro. Dentro `VOL_CFG` c'e' SOLO
# `cyberstrike.json` (provider + modello) — nessuna credenziale, e
# `credentials.json` non e' montata. Il rischio qui non e' il furto di un
# segreto: e' far scrivere all'agente la propria configurazione.
#
# Il perimetro qui e' doppio e serve perche' i due esiti sono diversi:
#   1. la config NON si scrive        -> EROFS
#   2. `bb hunt` continua a FUNZIONARE -> altrimenti il confinement e' a prezzo
#                                       della caccia, cioe' inutile
# Un test che verifica solo il punto 1 passerebbe anche avendo rotto tutto.
#
# Controprova: con `csconfig:rw` questo test deve diventare rosso.

HERE="$(cd "$(dirname "$0")" && pwd)"
PROG="${1:-bcny}"
REPO="$(cd "$HERE/../.." && pwd)"
# Container DEDICATO, con trap che lo rimuove: `--rm` non basta e il trap del
# chiamante non gira durante un `docker exec` in foreground (misurato il
# 2026-09-28). La leva che funziona e' `docker rm -f`.
KEEP_NAME="cyberstrike-v17-$$"
export CYBERSTRIKE_SANDBOX_NAME="$KEEP_NAME"

# Volume usa-e-getta per la config, e non `cyberstrike-config`.
# Difetto segnalato dal subagent (deleg_cb90184f), MISURATO: il test 3
# ispezionava il volume `cyberstrike-config` scritto a mano nella riga del
# `docker run`, mentre il launcher poteva aver montato un volume diverso
# (per un override, o per un refuso). Il controllo di integrita' certificava
# allora un volume che il test non aveva mai toccato. Qui il volume si crea,
# si passa al launcher via env, e si ispeziona lo STESSO volume — cosi' la
# prova e' sulla config che il container ha davvero avuto.
TEST_VOL="cyberstrike-v17-cfg-$$"
seed_volume() {
  docker volume rm -f "$TEST_VOL" >/dev/null 2>&1 || true
  # Si parte da una copia fedele del volume reale, altrimenti il test
  # passerebbe perche' manca `cyberstrike.json` e non perche' e' in ro.
  docker run --rm -u 0 -v "${VOL_CFG_REAL:-cyberstrike-config}:/src:ro" -v "$TEST_VOL":/dst \
    alpine sh -c 'mkdir -p /dst && cp -a /src/. /dst/ 2>/dev/null; true'
  chown_volume() {
    docker run --rm -u 0 -v "$TEST_VOL":/dst alpine \
      sh -c 'chown -R 1000:1000 /dst 2>/dev/null; true'
  }
  chown_volume
}
export VOL_CFG="$TEST_VOL"

cleanup() {
  docker rm -f "$KEEP_NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$TEST_VOL" >/dev/null 2>&1 || true
  # Il CONTROLO POSITIVO scrive davvero in `programs/<prog>/tmp/`, che e'
  # un percorso persistente sull'host: senza questa riga il test lasciava
  # `PROVA_POS` dentro la cartella del programma reale. Residuo misurato
  # dopo la prima esecuzione.
  rm -f "${CYBERSTRIKE_HOME:-$HOME/.cyberstrike}/bugbounty/programs/$PROG/tmp/PROVA_POS" 2>/dev/null || true
}
trap cleanup EXIT

seed_volume

echo "=== V17: configurazione in sola lettura (programma=$PROG) ==="
echo "  volume config sotto test: $TEST_VOL (copia usa-e-getta di cyberstrike-config)"

AVAIL=$(free -m | awk 'NR==2{print $7}')
echo "  memoria libera: ${AVAIL} MB"
if [ "${AVAIL:-0}" -lt 2048 ]; then
  echo "  KO  memoria < 2 GB, non avvio"; exit 1
fi

FAIL=0

# --- 1. la config deve essere NEGATA --------------------------------------
echo "-- test 1: scrittura nella config NEGATA --"
out=$(timeout 240 bash "$HERE/run-sandbox.sh" --keep --program "$PROG" \
  test -c '
    for f in /home/hunter/csconfig/cyberstrike.json /home/hunter/csconfig/cyberstrike/PROVA_V17 /home/hunter/csconfig/.gitignore; do
      if echo SCRIVI >> "$f" 2>/dev/null; then echo "SCRITTO: $f"; else echo "NEGATO: $f"; fi
    done
    # il caso che il perimetro applicativo non copre: scrittura opaca.
    # Non ispezionabile da ruleset, ma il filesystem deve negarla.
    if python3 -c "open(\"/home/hunter/csconfig/PROVA_OPACA\",\"w\").write(\"x\")" 2>/dev/null; then
      echo "SCRITTO: /home/hunter/csconfig/PROVA_OPACA"
    else
      echo "NEGATO: /home/hunter/csconfig/PROVA_OPACA"
    fi
  ' 2>&1)
rc=$?
echo "$out" | grep -E '^(SCRITTO|NEGATO):' | sed 's/^/  /'

if [ "$rc" -ne 0 ]; then
  echo "  KO  il launcher e' uscito con rc=$rc: il perimetro non e' stato provato"
  tail -3 <<<"$out" | sed 's/^/      /'
  FAIL=1
fi
# 4 attesi: 3 path + il caso opaco
if [ "$(grep -cE '^NEGATO:' <<<"$out")" -ne 4 ]; then
  echo "  KO  attesi 4 NEGATO, trovati $(grep -cE '^NEGATO:' <<<"$out"): la prova e' incompleta"
  FAIL=1
fi
if ! grep -qE '^(SCRITTO|NEGATO):' <<<"$out"; then
  echo "  KO  il container non ha girato: il test non misura niente"
  tail -3 <<<"$out" | sed 's/^/      /'
  FAIL=1
fi
if grep -q '^SCRITTO:' <<<"$out"; then
  echo "  KO  la config e' SCRIVIBILE: $(grep -m1 '^SCRITTO:' <<<"$out")"
  FAIL=1
else
  echo "  ok  nessun file di config scritto, nemmeno in forma opaca"
fi

# --- 1b. CONTROLLO POSITIVO: il probe sa scrivere? -----------------------
# se il container non puo' scrivere DA PARTE, "NEGATO" e' verde ovunque e il
# test non misura niente. La stessa identita' (hunter, uid 1000) deve poter
# scrivere nelle zone che restano rw: la tmp del programma e il volume dati.
echo "-- test 1b: CONTROLLO POSITIVO (la tmp del programma e' scrivibile) --"
out2=$(timeout 180 bash "$HERE/run-sandbox.sh" --keep --program "$PROG" \
  test -c '
    d=/work/bugbounty/programs/'"$PROG"'
    mkdir -p "$d/tmp" 2>/dev/null
    if echo SCRIVI > "$d/tmp/PROVA_POS" 2>/dev/null; then echo "SCRITTO: $d/tmp/PROVA_POS"; else echo "NEGATO: $d/tmp/PROVA_POS"; fi
    if echo SCRIVI > /home/hunter/csdata/PROVA_POS 2>/dev/null; then echo "SCRITTO: /home/hunter/csdata/PROVA_POS"; else echo "NEGATO: /home/hunter/csdata/PROVA_POS"; fi
  ' 2>&1)
echo "$out2" | grep -E '^(SCRITTO|NEGATO):' | sed 's/^/  /'
# Difetto segnalato dal subagent (deleg_cb90184f), MISURATO: contare le righe
# `SCRITTO:` non prova che siano uscite dai tentativi di scrittura — si
# potevano sostituire con due righe prefabbricate e il test passava. Qui si
# pretendono i DUE percorsi esatti, per nome.
if ! grep -q "^SCRITTO: /work/bugbounty/programs/$PROG/tmp/PROVA_POS$" <<<"$out2"; then
  echo "  KO  la tmp del programma non e' scrivibile, o il probe non l'ha provata"
  FAIL=1
fi
if ! grep -q "^SCRITTO: /home/hunter/csdata/PROVA_POS$" <<<"$out2"; then
  echo "  KO  il volume dati non e' scrivibile, o il probe non l'ha provato"
  FAIL=1
fi
if [ "$(grep -cE '^SCRITTO:' <<<"$out2")" -ne 2 ]; then
  echo "  KO  il probe non riesce a scrivere nelle zone che DEVONO essere scrivibili"
  echo "      (se fosse cosi', i NEGATO del test 1 non dimostrerebbero nulla)"
  tail -3 <<<"$out2" | sed 's/^/      /'
  FAIL=1
elif grep -qE '^NEGATO:' <<<"$out2"; then
  echo "  KO  una zona che doveva essere scrivibile ha risposto NEGATO"
  FAIL=1
else
  echo "  ok  il probe sa scrivere davvero, nei due percorsi attesi: i NEGATO del test 1 sono veri"
fi

# --- 2. bb hunt continua a FUNZIONARE -------------------------------------
# Il pericolo vero di una mount ro: `global/index.ts:30` esegue
# `fs.mkdir(Global.Path.config, { recursive: true })` dentro un `Promise.all`
# che NON cattura. Se quel path cambiasse, l'avvio muore e la caccia non
# parte — e il test 1 resterebbe verde lo stesso.
echo "-- test 2: bb hunt continua a funzionare con la config in ro --"
out3=$(timeout 300 bash "$HERE/run-sandbox.sh" --keep --program "$PROG" \
  test -c '
    cd /app/packages/cyberstrike
    timeout 200 bun run --conditions=browser src/index.ts bb hunt '"$PROG"' --dry-run 2>&1
    echo "RC=$?"
  ' 2>&1)
echo "$out3" | grep -E 'RC=|sincronizzerei|error:|ENOENT|EROFS|Permission denied' | head -8 | sed 's/^/  /'
if ! grep -qE 'RC=[0-9]+' <<<"$out3"; then
  echo "  KO  bb hunt non ha girato: il test non misura niente"
  tail -5 <<<"$out3" | sed 's/^/      /'
  FAIL=1
elif grep -qE 'EROFS|Permission denied' <<<"$out3"; then
  echo "  KO  bb hunt e' morto perche' la config e' in sola lettura"
  FAIL=1
else
  rc3=$(grep -oE 'RC=[0-9]+' <<<"$out3" | head -1 | cut -d= -f2)
  # La prima stesura accettava QUALSIASI rc: dichiarava `ok` anche con
  # rc=139 (crash) e con output vuoto. Misurato in questo stesso file. Il
  # `:ro` non deve cambiare l'esito di `bb hunt`, quindi l'unico rc
  # accettabile e' 0 — e non basta: serve anche che il dry-run abbia
  # prodotto l'output che ci si aspetta, altrimenti un `true` finale
  # maschererebbe un fallimento.
  if [ "$rc3" -ne 0 ]; then
    echo "  KO  bb hunt e' uscito con rc=$rc3 (atteso 0): il :ro ha rotto qualcosa"
    echo "$out3" | grep -vE '^RC=' | tail -6 | sed 's/^/      /'
    FAIL=1
  elif ! grep -qE 'sincronizzerei|=== MESSAGGIO INIZIALE ===' <<<"$out3"; then
    echo "  KO  bb hunt ha rc=0 ma non ha stampato l'output del dry-run"
    echo "$out3" | tail -6 | sed 's/^/      /'
    FAIL=1
  else
    echo "  ok  bb hunt ha girato (rc=0) e ha stampato il dry-run, senza EROFS"
  fi
fi

# --- 3. il volume NON e' stato alterato, ne' per scrittura ne' per
# sovrascrittura. Misurato durante la controprova: `echo SCRIVI >> file`
# su `cyberstrike.json` e `.gitignore` li CORROMPE (7 byte, testo non JSON),
# e il test 3 nella prima stesura guardava solo i file PROVA, quindi il
# volume poteva restare corrotto e il test verde. Qui si verifica anche
# che i file veri siano intatti.
echo "-- test 3: il volume e' intatto, non solo privo di PROVA --"
# Il verdetto viaggia nel CODICE DI USCITA, non in una riga "OK": nella prima
# stesura il subshell stampava `OK` incondizionatamente e il `grep '^OK'`
# era vero anche a volume corrotto — un falso verde misurato in questo stesso
# file. `MANCA:`/`CORROTTO:`/`PRESENTE:` restano in output per il diagnostico,
# ma il verdetto e' `rc`.
docker run --rm -u 0 -v "$TEST_VOL":/dst:ro alpine sh -c '
  ok=1
  [ -f /dst/cyberstrike.json ] || { echo "MANCA: cyberstrike.json"; ok=0; }
  # Non basta il primo byte: il subagent ha misurato che `{broken-json`
  # soddisfa "inizia con {". Quindi si controlla anche che il file non sia
  # spazzatura di 7 byte. La prova forte che il file sia utilizzabile e
  # il test 2 -- bb hunt rc=0 con il dry-run -- non questa qui.
  head -c 1 /dst/cyberstrike.json 2>/dev/null | grep -q "{" || { echo "CORROTTO: cyberstrike.json non e un oggetto JSON"; ok=0; }
  [ "$(wc -c < /dst/cyberstrike.json 2>/dev/null || echo 0)" -lt 200 ] && { echo "CORROTTO: cyberstrike.json troppo corto"; ok=0; }
  [ -f /dst/cyberstrike/PROVA_OPACA ] && { echo "PRESENTE: PROVA_OPACA"; ok=0; }
  [ -f /dst/PROVA_V17 ] && { echo "PRESENTE: PROVA_V17"; ok=0; }
  [ -f /dst/cyberstrike/PROVA_V17 ] && { echo "PRESENTE: cyberstrike/PROVA_V17"; ok=0; }
  exit $((1-ok))' > /tmp/v17-state.$$ 2>&1
rc3v=$?
grep -E '^(MANCA|CORROTTO|PRESENTE)' /tmp/v17-state.$$ | sed 's/^/  /'
rm -f /tmp/v17-state.$$
if [ "$rc3v" -ne 0 ]; then
  echo "  KO  il volume e' stato alterato dalla prova (corrotto, non solo sporcato)"
  FAIL=1
else
  echo "  ok  cyberstrike.json e' integro e non ci sono residui"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "V17: OK — la config non e' scrivibile, il probe sì, bb hunt funziona."
  exit 0
fi
echo "V17: FALLITO"
exit 1
