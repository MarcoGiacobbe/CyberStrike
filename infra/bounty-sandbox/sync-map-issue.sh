#!/bin/bash
# Pubblica wayfinder/bb-autonomous-flow/MAP.md come corpo dell'issue #2.
#
# Che cosa fa, e perché esiste. La MAP è UNA sola informazione che deve essere
# leggibile in due posti: il file nel repo, che è la versione lavorata, e
# l'issue GitHub #2, che è la bacheca dove si discute. Sono due copie dello
# stesso testo, quindi vanno tenute allineate — a mano divergono, perché ognuna
# viene toccata in momenti diversi e nessuno si ricorda dell'altra.
#
# Prima di questo script sono arrivate a essere due mappe diverse: 175 righe nel
# file contro 133 riscritte a mano sull'issue, con sezioni presenti in una e
# assenti nell'altra. E la MAP contraddiceva sé stessa: V6 dichiarata "risolta"
# in alto e "parziale" in coda, il difetto TUI "aperto — BLOCCANTE" in una riga
# e "ritirato" in quella immediatamente seguente.
#
# L'issue pubblica il testo INTEGRALE del file, non un riassunto: se riassumesse,
# l'issue stessa diventerebbe una seconda copia da tenere allineata — cioè di
# nuovo due fonti, solo più corte.
#
# Uso:
#   ./sync-map-issue.sh          -> pubblica e verifica
#   ./sync-map-issue.sh check    -> confronta senza modificare nulla
#   ./sync-map-issue.sh verify   -> solo verifica (esce 1 se divergono)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MAP="$REPO/wayfinder/bb-autonomous-flow/MAP.md"
ISSUE="${CYBERSTRIKE_MAP_ISSUE:-2}"

cd "$REPO"

[ -f "$MAP" ] || { echo "ERR: MAP non trovata in $MAP" >&2; exit 1; }

# `-B` perché GitHub aggiunge una newline finale al corpo dell'issue: senza
# questa opzione `diff` segnalerebbe per sempre un'ultima riga vuota come
# differenza, e la verifica segnalerebbe una divergenza che non esiste.
check() {
  local tmp
  tmp="$(mktemp)"
  gh issue view "$ISSUE" --json body --jq '.body' > "$tmp"
  if diff -q -B "$MAP" "$tmp" >/dev/null; then
    rm -f "$tmp"
    echo "allineati: l'issue #$ISSUE contiene esattamente $MAP"
    return 0
  fi
  echo "DIVERGONO — l'issue #$ISSUE NON contiene $MAP:"
  diff -B "$MAP" "$tmp" | head -"${DIFF_LINES:-40}" || true
  rm -f "$tmp"
  return 1
}

case "${1:-push}" in
  check)
    echo "file MAP:       $(wc -l < "$MAP") righe, $(wc -c < "$MAP") byte"
    echo "issue #$ISSUE: $(gh issue view "$ISSUE" --json body --jq '.body' | wc -l) righe"
    check || true
    ;;
  verify)
    check
    ;;
  push)
    gh issue edit "$ISSUE" --body-file "$MAP" >/dev/null
    echo "issue #$ISSUE pubblicata da $MAP"
    check
    ;;
  *)
    echo "uso: $0 [push|check|verify]" >&2
    exit 1
    ;;
esac
