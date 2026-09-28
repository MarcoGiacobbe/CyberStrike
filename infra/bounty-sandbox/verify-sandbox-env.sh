#!/usr/bin/env bash
# Container di verifica UNICO e riusato.
#
# Prima ogni probe faceva `docker run`: sei container di fila, ~800MB di TUI
# ciascuno e il mount del repo da 5.4GB rimontato ogni volta. Il risultato
# era lo stesso ma il costo si ripeteva a ogni test.
#
# Ora si avvia UNA volta sola un container "sabbia" (sleep infinity) e i probe
# ci entrano con `docker exec`. Costo fisso, non ripetuto.
#
# Uso:
#   source verify-sandbox-env.sh
#   sandbox_exec <comando>...      # dentro il container
#   sandbox_stop                   # ferma e rimuove
set -uo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-cyberstrike-verify-sabbia}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-cyberstrike-bounty:sandbox}"
SANDBOX_MEM="${SANDBOX_MEM:-2g}"
SANDBOX_PROGRAM="${SANDBOX_PROGRAM:-bcny}"

# Il repo in sola lettura: il codice del perimetro non e' scrivibile
# dall'agente, quindi nessun test puo' auto-certificarsi.
_sandbox_repo() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$here/../.." && pwd
}

sandbox_alive() {
  docker ps --format '{{.Names}}' | grep -qx "$SANDBOX_NAME"
}

sandbox_start() {
  if sandbox_alive; then
    return 0
  fi
  # se un container fermo con lo stesso nome esiste, non accumularne altri
  docker rm -f "$SANDBOX_NAME" >/dev/null 2>&1

  local repo
  repo="$(_sandbox_repo)"
  local prog_host="${CYBERSTRIKE_HOME:-$HOME/.cyberstrike}/bugbounty/programs/$SANDBOX_PROGRAM"
  local prog_cont="/work/bugbounty/programs/$SANDBOX_PROGRAM"

  if [ ! -d "$prog_host" ]; then
    echo "sandbox_start: programma non trovato: $prog_host" >&2
    return 1
  fi
  if [ -L "$prog_host" ]; then
    echo "sandbox_start: il programma e' un symlink, rifiutato" >&2
    return 1
  fi

  docker run -d --name "$SANDBOX_NAME" \
    --memory="$SANDBOX_MEM" \
    -v "$repo":/app:ro \
    -v "$prog_host":"$prog_cont":rw \
    --entrypoint sleep \
    "$SANDBOX_IMAGE" infinity >/dev/null || return 1

  # CONTROLLO POSITIVO: verifico che il container sia davvero partito e che
  # il programma sia montato. Senza questo, un avvio fallito silenzioso
  # renderebbe verdi i test che non misurano nulla.
  if ! sandbox_alive; then
    echo "sandbox_start: il container non e' partito" >&2
    return 1
  fi
  if ! docker exec "$SANDBOX_NAME" test -d "$prog_cont"; then
    echo "sandbox_start: il programma non e' montato dentro" >&2
    return 1
  fi
  return 0
}

sandbox_exec() {
  docker exec "$SANDBOX_NAME" "$@"
}

sandbox_stop() {
  docker rm -f "$SANDBOX_NAME" >/dev/null 2>&1
  return 0
}
