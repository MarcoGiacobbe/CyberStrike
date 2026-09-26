#!/bin/bash
# Allinea l'issue #2 alla mappa.
#
# STORIA DEL DIFETTO (2026-09-26, da non ripetere): la MAP esisteva in due copie
# indipendenti — il file nel repo e il corpo dell'issue #2 — tenute allineate a
# mano. Divergono ogni volta che una delle due viene toccata. Sono arrivate a
# essere due mappe diverse: 175 righe nel file contro 133 riscritte a mano
# sull'issue, con sezioni presenti in una e assenti nell'altra.
#
# COME SI RISOLVE, e perché non con una terza sincronizzazione: non si tiene
# allineata la MAP, non la si duplica proprio. L'issue contiene un PUNTATORE al
# file più un indice delle sezioni. Il testo della mappa vive in un posto solo,
# dentro il repository, che è già versionato e già nel branch.
#
# Conseguenza voluta: modificare la MAP non richiede più di scrivere il file e
# fare un commit. Niente passo di sincronizzazione, quindi niente che si possa
# dimenticare — la divergenza che questo script impediva ora non è possibile
# perché il testo non è duplicato da nessuna parte.
#
# Uso:
#   ./sync-map-issue.sh          -> pubblica MAP-ISSUE.md come corpo dell'issue #2
#   ./sync-map-issue.sh check    -> mostra le dimensioni senza toccare nulla
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BODY="$REPO/wayfinder/bb-autonomous-flow/MAP-ISSUE.md"
MAP="$REPO/wayfinder/bb-autonomous-flow/MAP.md"
ISSUE="${CYBERSTRIKE_MAP_ISSUE:-2}"

cd "$REPO"

[ -f "$BODY" ] || { echo "ERR: manca $BODY" >&2; exit 1; }
[ -f "$MAP" ]  || { echo "ERR: manca $MAP" >&2; exit 1; }

# Il puntatore dentro il corpo deve puntare al branch giusto: su un branch morto
# il link apre una 404 e l'issue torna a essere un testo senza fonte.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if ! grep -q "blob/$BRANCH/wayfinder/bb-autonomous-flow/MAP.md" "$BODY"; then
  echo "ERR: il link in MAP-ISSUE.md non punta al branch corrente ($BRANCH)" >&2
  echo "     correggilo, altrimenti l'issue rimanda a una 404" >&2
  exit 1
fi

case "${1:-push}" in
  check)
    echo "MAP:           $MAP"
    echo "  $(wc -l < "$MAP") righe, $(wc -c < "$MAP") byte"
    echo "corpo issue:   $BODY"
    echo "  $(wc -l < "$BODY") righe, $(wc -c < "$BODY") byte"
    echo "issue #$ISSUE: $(gh issue view "$ISSUE" --json body --jq '.body' | wc -l) righe"
    ;;
  push)
    gh issue edit "$ISSUE" --body-file "$BODY" >/dev/null
    echo "issue #$ISSUE aggiornata"
    TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
    gh issue view "$ISSUE" --json body --jq '.body' > "$TMP"
    if diff -q -B "$BODY" "$TMP" >/dev/null; then
      echo "verificato: il corpo remoto e' identico a MAP-ISSUE.md"
    else
      echo "DIVERGE:"; diff -B "$BODY" "$TMP" | head -20; exit 1
    fi
    ;;
  *)
    echo "uso: $0 [check|push]" >&2; exit 1 ;;
esac
