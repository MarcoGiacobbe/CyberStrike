#!/bin/bash
# Crea cyberstrike.json nella directory dei programmi, con il provider "omni"
# dichiarato esplicitamente. CyberStrike non conosce HERMES_CUSTOM_OMNI_API_KEY:
# la lista dei provider viene da models.dev filtrata per chiave riconosciuta, e
# un env con un nome sconosciuto viene ignorato ("no providers found").
#
# I provider si dichiarano in `provider` con `options.apiKey` oppure con
# `npm`: "@ai-sdk/<vendor>". Qui si usa il vendor "openai-compatible" via
# l'adapter generico, che e' quello che parla con OmniRoute.
set -euo pipefail

CFG="${CYBERSTRIKE_HOME:-$HOME/.cyberstrike}/bugbounty/cyberstrike.json"
mkdir -p "$(dirname "$CFG")"

if [ -z "${HERMES_CUSTOM_OMNI_API_KEY:-}" ]; then
  echo "❌ HERMES_CUSTOM_OMNI_API_KEY non impostata su questa shell."
  echo "   La chiavi sta nella config di Hermes, non nell'ambiente della shell:"
  echo "   ~/.hermes/config.yaml -> provider custom 'omni'."
  echo "   Esportala prima, o metti il valore nel file (NON raccomandato)."
  exit 1
fi

# Non si stampa la chiave. La si scrive nel file con permessi stretti.
umask 077
python3 - "$CFG" <<'PY'
import json, os, sys
cfg_path = sys.argv[1]
key = os.environ["HERMES_CUSTOM_OMNI_API_KEY"]
base = os.environ.get("CYBERSTRIKE_PROVIDER_BASE", "http://192.168.49.84:20128/v1")
cfg = {
  "$schema": "https://cyberstrike.io/config.json",
  "provider": {
    "omni": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OmniRoute (omni)",
      "options": { "baseURL": base, "apiKey": key },
      "models": {
        "best-coding": { "name": "omni best-coding" },
        "auto/best-coding": { "name": "omni auto/best-coding" }
      }
    }
  }
}
with open(cfg_path, "w") as f:
    json.dump(cfg, f, indent=2)
os.chmod(cfg_path, 0o600)
print(f"  scritto {cfg_path} (0600), baseURL={base}")
PY
