#!/bin/bash
# Pubblica wayfinder/bb-autonomous-flow/MAP.md come corpo dell'issue #2.
#
# Perché questo script esiste: la MAP esisteva in DUE copie — il file locale e
# il corpo dell'issue GitHub — e le due divergevano. Io (l'autore) le tenevo
# allineate a mano, che è esattamente il modo in cui divergono: la copia
# GitHub era una riscrittura condensata, più corta, con sezioni che il file non
# aveva e senza quelle che aveva.
#
# La regola adesso è meccanica: **una sola sorgente di verità, il file**. L'issue
# non è una copia redatta a mano, è il file. Non esiste più un secondo testo da
# tenere allineato.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MAP="$REPO/wayfinder/bb-autonomous-flow/MAP.md"
ISSUE="${CYBERSTRIKE_MAP_ISSUE:-2}"

cd "$REPO"

if [ ! -f "$MAP" ]; then
  echo "ERR: MAP non trovata in $MAP" >&2
  exit 1
fi

# La MAP e' dentro il repo, quindi non si puo' scrivere un path assoluto del
# container (/work/...) nell'issue: le righe che descrivono i path del container
# si riferiscono a come il container le vede, e va detto, altrimenti chi legge
# l'issue su GitHub li prende per path del repository.
MODE="${1:-check}"

case "$MODE" in
  check)
    echo "=== MAP locale ==="
    wc -l -c "$MAP"
    echo
    echo "=== issue #$ISSUE pubblicata ==="
    gh issue view "$ISSUE" --json body --jq '.body' | wc -l -c
    echo
    echo "per sincronizzare:  $0 push"
    ;;
  push)
    gh issue edit "$ISSUE" --body-file "$MAP" >/dev/null
    echo "issue #$ISSUE aggiornata dal file $(basename "$MAP")"
    # Riverifica RILEGGENDO il corpo remoto e confrontandolo riga per riga con
    # il file. Il primo tentativo confrontava uno sha256 e falliva sempre:
    # GitHub aggiunge una newline finale al corpo, quindi gli sha non possono
    # coincidere per costruzione — la verifica segnalava una divergenza che non
    # esisteva. Il confronto reale dice: una sola riga di differenza, e una
    # newline in piu' dal lato remoto.
    TMP="$(mktemp)"
    trap 'rm -f "$TMP"' EXIT
    gh issue view "$ISSUE" --json body --jq '.body' > "$TMP"
    # `diff` senza opzioni segnala l'ultima riga vuota mancante come differenza
    # (`175a176 >`). Con `-B` ignora i cambi di quantita' di righe vuote, che e'
    # l'unica differenza reale: GitHub aggiunge una newline finale.
    if diff -q -B "$MAP" "$TMP" >/dev/null; then
      echo "verificato: il corpo remoto e' identico al file, riga per riga"
    else
      echo "DIVERGE (oltre alla newline finale):"
      diff -B "$MAP" "$TMP" | head -20
      exit 1
    fi
    ;;
  *)
    echo "uso: $0 [check|push]" >&2
    exit 1
    ;;
esac
