#!/bin/bash
# Probe per V14: gira DENTRO il container e guarda cosa esiste davvero.
# E' un file separato invece di una stringa passata con -c perche' il quoting
# annidato (virgola rossa dentro apici dentro apici) si e' rotto due volte in
# fila: un test che muore per quoting non distingue "il perimetro ha negato"
# da "la mia shell era malformata". Il repo e' gia' montato in /app, quindi
# questo file e' gia' dentro il container e va invocato con argomenti normali.
#
# Uso: verify-v14-probe.sh <programma> <altro-programma>
# Exit 0 = tutto come previsto. Non stampa segreti: dice solo se il file c'e'.
set -u

# DUBBIO: se questo probe trova un KO ma esce comunque con 0, il test chiama
# PASS un montaggio largo. Percio' qui ogni KO mette KO=1 e lo script esce
# con 1. Il test guarderà anche il testo dei KO, perche' l'exit code da solo
# non distingue un KO da un crash.
KO=0
fail() { echo "  KO  $1"; KO=1; }

PROG="${1:?manca il programma}"
ALTRO="${2:?manca l-altro-programma}"
BB=/work/bugbounty

echo "### dentro il container ###"
echo "-- contenuto reale di $BB --"
ls -la "$BB" 2>&1 || echo "  $BB ASSENTE"

echo "-- test 1: credentials.json --"
if [ -e "$BB/credentials.json" ]; then
  fail "CREDENTIALS PRESENTI (il file esiste e l'agente puo' leggerlo)"
else
  echo "  ok  credentials.json ASSENTE: non e' nel container, quindi non e' leggibile"
fi

echo "-- test 2: config di altri programmi --"
for p in bookingcom smoketest security bcny-test arc; do
  if [ -e "$BB/$p.json" ] || [ -e "$BB/$p.accounts.json" ]; then
    fail "$p presente: config di un programma non assegnato"
  else
    echo "  ok  $p assente"
  fi
done

echo "-- test 3: programs/ contiene solo il programma assegnato --"
ls "$BB/programs" 2>&1 | sed 's/^/    /'
CNT=$(ls "$BB/programs" 2>/dev/null | grep -c . || echo 0)
if [ "$CNT" -eq 1 ] && [ -d "$BB/programs/$PROG" ]; then
  echo "  ok  un solo programma montato: $PROG"
else
  fail "trovati $CNT programmi, atteso 1 ($PROG)"
fi

echo "-- test 4: SCRITTURA dentro programs/$PROG (CONTROLLO POSITIVO) --"
T="v14-positivo-$$.txt"
rm -f "$BB/programs/$PROG/$T" 2>/dev/null   # un residuo del run precedente renderebbe PASS un mount ro
if printf 'POSITIVO-OK\n' > "$BB/programs/$PROG/$T" 2>/dev/null; then
  echo "  ok  scritto dentro: $(cat "$BB/programs/$PROG/$T")"
  echo "  marker: $T"
else
  fail "scrittura DENTRO fallita: il tool e' rotto o il mount assente"
fi

echo "-- test 5: SCRITTURA in programs/$ALTRO (controllo negativo) --"
A="v14-fuga-$$.txt"
if printf 'FUGA\n' > "$BB/programs/$ALTRO/$A" 2>/dev/null; then
  fail "scrittura in programs/$ALTRO RIUSCITA: FUGA"
else
  echo "  ok  scrittura in programs/$ALTRO negata dal filesystem"
fi

exit "$KO"
