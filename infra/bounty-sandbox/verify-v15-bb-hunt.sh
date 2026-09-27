#!/bin/bash
# V15 — `bb hunt` continua a funzionare con i mount stretti.
#
# V14 ha chiuso la fuga laterale restringendo i mount. Il rischio di questa
# modifica non e' che il perimetro si indebolisca, ma che `bb hunt` smetta
# di funzionare: e' esattamente cio' che e' successo. Il launcher passava
# `bb hunt ...` come MESSAGGIO a `cyberstrike run`, quindi una sessione LLM
# leggeva il sorgente invece di eseguire il comando, e `--dry-run` non
# stampava mai `=== MESSAGGIO INIZIALE ===`.
#
# Questo test fallisce se il comando non produce il perimetro. Non e' una
# prova di sicurezza: e' una prova di NON REGRESSIONE di funzionalita'.
# Se qualcuno lo etichetta "prova che il perimetro regge", ha capito male:
# il perimetro lo dimostra V14.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROG="${1:-bcny}"
OUT="/tmp/v15-dryrun.txt"

echo "=== V15: bb hunt --dry-run con mount stretti (programma=$PROG) ==="

free -m | awk 'NR==2 {printf "  memoria libera: %d MB\n", $4}'

out=$(timeout 240 bash "$HERE/run-sandbox.sh" --program "$PROG" \
  bb hunt "$PROG" --dry-run 2>&1)
rc=$?
echo "$out" > "$OUT"

fail=0
need() {
  if grep -qF "$1" "$OUT"; then
    echo "  ok  trovato: $1"
  else
    echo "  KO  ASSENTE: $1"
    fail=1
  fi
}

echo "-- il comando e' stato eseguito, non passato come messaggio all'agente --"
need "=== MESSAGGIO INIZIALE ==="
need "=== PERIMETRO ==="
need "=== STATO ==="

echo "-- il perimetro e' quello del programma, non della root --"
need "directory progetto: /work/bugbounty/programs/$PROG"
# Una regola `allow edit` che puntasse alla root aprirebbe di nuovo tutto.
if grep -qE 'allow +(edit|external_directory) +/\*' "$OUT"; then
  echo "  KO  c'e' una regola allow su /* : aprirebbe il perimetro"
  fail=1
else
  echo "  ok  nessuna regola allow su /*"
fi

echo "-- lettura libera, scrittura confinata --"
if grep -q "allow  read  \*" "$OUT"; then
  echo "  ok  lettura libera (read allow *)"
else
  echo "  KO  lettura non libera: regressione sulla richiesta utente"
  fail=1
fi
if grep -q "deny  edit  \*" "$OUT"; then
  echo "  ok  deny edit * presente"
else
  echo "  KO  manca deny edit *"
  fail=1
fi

echo "-- il programma e' realmente montato --"
if grep -q "NON montati: credentials.json" <<<"$out"; then
  echo "  ok  il launcher dichiara i mount stretti"
else
  echo "  KO  il launcher non dichiara i mount stretti"
  fail=1
fi

# Il perimetro deve puntare al path DENTRO il container, non a quello della
# macchina dell'utente: se tornasse /home/marco/.cyberstrike/... il perimetro
# sarebbe costruito su una directory che nel container non esiste.
if grep -qE "allow +edit +/home/marco" <<<"$out"; then
  echo "  KO  il perimetro contiene path dell'host: nel container non esiste"
  fail=1
else
  echo "  ok  nessun path dell'host nelle regole"
fi

echo "-- exit code --"
echo "  run-sandbox rc=$rc"
[ "$rc" -eq 0 ] || { echo "  KO  exit non zero"; fail=1; }

echo
if [ "$fail" -eq 0 ]; then
  echo "V15: PASS — bb hunt eseguito col perimetro del programma"
else
  echo "V15: FAIL — vedi i KO sopra (output completo in $OUT)"
fi
exit "$fail"
