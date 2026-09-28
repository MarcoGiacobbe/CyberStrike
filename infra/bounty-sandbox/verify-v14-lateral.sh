#!/bin/bash
# V14 — chiusura della fuga laterale fra programmi.
#
# Il difetto: `run-sandbox.sh` montava TUTTA la root del bug bounty in rw.
# Il perimetro software copriva `programs/<programma>/`, ma il mount copriva
# anche `credentials.json` e i config di ogni altro programma, che l'agente
# poteva leggere E riscrivere. Il perimetro dichiarava un confine che il
# mount non applicava: due programmi diversi condividevano i segreti.
#
# La prova che conta NON e' "l'agente non ha letto il file": e' che il file
# NON ESISTE nel container. Un perimetro che nega e' comunque un perimetro
# che ha lasciato il segreto a portata di mano.
#
# Vincoli: 1 solo container alla volta, memoria libera >= 2 GB prima di partire,
# timeout SEMPRE, nessun TUI, cleanup in uscita.
set -uo pipefail

PROG="${1:-bcny}"
ALTRO="${2:-bcny-test}"
BB="${CYBERSTRIKE_HOME:-$HOME/.cyberstrike}/bugbounty"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="cs-v14-$$"
FAIL=0
# Il container di questo test ha un nome suo, non `cyberstrike-bounty`: quello
# e' della caccia e va lasciato intatto. `run-sandbox.sh` legge il nome da
# `CYBERSTRIKE_SANDBOX_NAME`.
export CYBERSTRIKE_SANDBOX_NAME="$NAME"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # I marker del probe non devono restare nella directory del programma: sono
  # spazzatura di test dentro i dati della caccia, e un residuo puo' falsificare
  # il run successivo (vedi la pulizia pre-probe sopra).
  rm -f "$BB/programs/$PROG/"/v14-positivo-* 2>/dev/null || true
  rm -f "$BB/programs/$ALTRO/"/v14-fuga-* 2>/dev/null || true
}
trap cleanup EXIT
# Come in V16: `trap cleanup INT`/`TERM` da soli non terminano lo script in
# bash, quindi il container sopravvive al segnale. Serve l'`exit` esplicito.
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "=== V14: fuga laterale fra programmi (programma=$PROG, altro=$ALTRO) ==="

# --- controllo di precondizione: i file devono ESISTERE SULL'HOST, altrimenti
# --- "non raggiungibili nel container" non dimostra niente
echo "-- precondizioni sull'host --"
[ -f "$BB/credentials.json" ]      && echo "  ok  credentials.json esiste sull'host"      || { echo "  KO  credentials.json ASSENTE: test non valido"; exit 1; }
[ -f "$BB/bookingcom.json" ]       && echo "  ok  bookingcom.json esiste sull'host"       || echo "  -- bookingcom.json assente (test piu' debole su questo punto)"
[ -f "$BB/smoketest.json" ]        && echo "  ok  smoketest.json esiste sull'host"        || echo "  -- smoketest.json assente (test piu' debole su questo punto)"
[ -f "$BB/$PROG.json" ]            && echo "  ok  $PROG.json esiste sull'host"            || { echo "  KO  $PROG.json ASSENTE: test non valido"; exit 1; }
mkdir -p "$BB/programs/$PROG" "$BB/programs/$ALTRO"
[ -d "$BB/programs/$PROG" ]       && echo "  ok  programs/$PROG esiste"
[ -d "$BB/programs/$ALTRO" ]      && echo "  ok  programs/$ALTRO esiste"
echo "  ok  (positivi verificati sull'host: i bersagli esistono)"

# --- il container deve partire, e partire BENE: un container rotto fa
# --- fallire ogni verifica successiva senza dirlo
echo "-- avvio container con --program $PROG --"
free -m | awk 'NR==2{printf "  memoria libera: %s MB\n",$7}'
AVAIL=$(free -m | awk 'NR==2{print $7}')
if [ "${AVAIL:-0}" -lt 2048 ]; then
  echo "  KO  memoria < 2 GB, non avvio"; exit 1
fi

# Il probe e' un FILE del repo, gia' montato in /app dentro il container.
# Non stdin (manca -i a docker run: `bash -s` uscirebbe 0 senza eseguire
# nulla, falso verde) ne env (`compgen -v` elenca le variabili di SHELL, non
# quelle d'ambiente: inoltrare env da questo launcher fallisce in silenzio).
# La riga di comando con argomenti normali e' l'unico canale affidabile.
# PRIMA del probe si cancellano TUTTI i marker di qualunque run precedente:
# il probe rimuove solo il proprio (il suo nome ha `$$`), e il controllo qui
# sotto cerca con un glob che matcha QUALSIASI `v14-positivo-*`. Senza questa
# pulizia un residuo renderebbe PASS un mount che in realta' e' in sola
# lettura: e' lo stesso falso verde chiuso in V14/V16, ricomparso perche' il
# test era diventato multi-run.
rm -f "$BB/programs/$PROG/"/v14-positivo-* 2>/dev/null || true
rm -f "$BB/programs/$ALTRO/"/v14-fuga-* 2>/dev/null || true
out=$(timeout 180 bash "$HERE/run-sandbox.sh" --keep --program "$PROG" \
  test -c "bash /app/infra/bounty-sandbox/verify-v14-probe.sh $PROG $ALTRO" 2>&1)
rc=$?
echo "$out"
echo "-- exit code run-sandbox: $rc --"

# --- i risultati devono arrivare: se il container non ha girato, nessuna
# --- delle righe "ok" qui sotto significa qualcosa
if ! grep -q "### dentro il container ###" <<<"$out"; then
  echo "V14 NON VALIDO: il container non ha prodotto output"
  exit 1
fi

# --- I KO DEL PROBE CONTANO. Il probe esce con 1 se trova un KO, ma da solo
# --- l'exit code non distingue "trovata una fuga" da "il probe e' crashato":
# --- quindi si controlla anche il testo. Senza questo, un montaggio largo
# --- stampava sei KO e V14 chiudeva lo stesso con PASS (riprodotto).
if grep -q '^ *KO ' <<<"$out"; then
  echo "  KO  il probe ha trovato problemi DENTRO il container:"
  grep '^ *KO ' <<<"$out" | sed 's/^/      /'
  FAIL=1
else
  echo "  ok  il probe non ha trovato nulla di anomalo dentro il container"
fi

echo "-- verifica dall'HOST (l'agente non puo' falsificare questa) --"
if compgen -G "$BB/programs/$PROG/v14-positivo-*" >/dev/null; then
  echo "  ok  il file positivo esiste sull'host:"
  ls -1 "$BB/programs/$PROG/" | grep 'v14-positivo' | sed 's/^/    /'
  cat "$BB/programs/$PROG/"v14-positivo-* 2>/dev/null | sed 's/^/    contenuto: /'
else
  echo "  KO  il file positivo NON e'"'"' arrivato sull'"'"'host: CONTROLLO POSITIVO FALLITO"
  FAIL=1
fi
if compgen -G "$BB/programs/$ALTRO/v14-fuga-*" >/dev/null; then
  echo "  KO  la fuga e'"'"' arrivata sull'"'"'host: $(ls -1 "$BB/programs/$ALTRO/" | grep v14-fuga)"
  FAIL=1
else
  echo "  ok  nessun file di fuga in programs/$ALTRO"
fi

echo
# --- V14b: i path montati non devono essere symlink ---------------------
# Il test sopra copre i programmi DIVERSI. Questo copre un vettore diverso,
# scoperto dalla revisione avversariale deleg_5f2afbf8: `docker -v` segue i
# symlink, quindi un `programs/<nome>` o un `<nome>.json` che sono link
# portano fuori dal perimetro senza alcun errore. Il test di sopra era verde
# anche in quella situazione: non misurava niente su questo punto.
#   - programs/bcny -> /tmp/altrove   => segreto di /tmp/altrove leggibile
#   - bcny.json -> credentials.json   => contenuto credenziali leggibile
# HOME isolata: non si tocca ~/.cyberstrike reale.
echo "=== V14b: rifiuto dei symlink sui path montati ==="
SBX_HOME="/tmp/v14b-home-$$"
FUORI="/tmp/v14b-fuori-$$"
mkdir -p "$SBX_HOME/bugbounty/programs" "$FUORI"
echo "SEGRETO_V14B" > "$FUORI/segreto.txt"
echo '{"token":"CREDENTIALS_V14B"}' > "$SBX_HOME/bugbounty/credentials.json"
mkdir -p "$SBX_HOME/bugbounty/programs/altro"

# caso 1: la directory del programma e' un link fuori da programs/
ln -s "$FUORI" "$SBX_HOME/bugbounty/programs/link1"
# caso 2: il config del programma e' un link alle credenziali
mkdir -p "$SBX_HOME/bugbounty/programs/link2"
ln -s "$SBX_HOME/bugbounty/credentials.json" "$SBX_HOME/bugbounty/link2.json"

for caso in link1 link2; do
  o=$(CYBERSTRIKE_HOME="$SBX_HOME" timeout 120 bash "$HERE/run-sandbox.sh" \
        --program "$caso" test -c 'echo SENTINEL-AVVIO-REALE-7f3a' 2>&1)
  if grep -q "SEGRETO_V14B" <<<"$o" || grep -q "CREDENTIALS_V14B" <<<"$o"; then
    echo "  KO  $caso: il contenuto sensibile e' comparso nell'output"
    FAIL=1
    continue
  fi
  if grep -q "RIFIUTO" <<<"$o"; then
    echo "  ok  $caso: rifiutato -> $(grep -m1 'RIFIUTO' <<<"$o" | cut -c1-90)"
  elif grep -q "SENTINEL-AVVIO-REALE-7f3a" <<<"$o"; then
    echo "  KO  $caso: ACCETTATO, il container e' partito col path montato"
    FAIL=1
  else
    echo "  KO  $caso: esito ambiguo (nessun rifiuto, nessun container):"
    tail -2 <<<"$o" | sed 's/^/      /'
    FAIL=1
  fi
done
rm -rf "$SBX_HOME" "$FUORI"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "V14: PASS — mount stretti, credenziali e altri programmi assenti, scrittura dentro funzionante, symlink rifiutati"
else
  echo "V14: FAIL — vedi i KO sopra"
fi
exit $FAIL
