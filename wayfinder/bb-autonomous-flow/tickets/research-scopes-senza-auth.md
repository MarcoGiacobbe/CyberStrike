# Ticket: Ricerca — structured_scopes senza auth per programmi public

## Question

`GET https://api.hackerone.com/v1/hackers/programs/bcny/structured_scopes`
risponde con dati reali SENNA autenticazione per un programma public? E
`GET .../programs/bcny` (policy)? Se sì, il primo fetch può essere AFK
senza token; il token serve solo per programmi privati/inviti e hacktivity.

## Method

curl/HTTP GET senza Authorization header; registrare status code e shape
JSON. Poi ripetere con Basic Auth fittizio per confermare la differenza.
FONTE: solo API reale HackerOne — niente supposizioni dai docs.

## Output atteso

- Status + shape (primi campi JSON) per i 2 endpoints senza auth
- Verdetto: fetch-anonimo possibile sì/no per (a) scope (b) policy

## RESOLUTION (2026-09-24, test reale)

AUTH-REQUIRED su tutti e 3 gli endpoint (401, body `{"errors":[{"status":401}]}`,
anche con Accept: application/json):
- `/v1/hackers/programs/bcny/structured_scopes` → 401
- `/v1/hackers/programs/bcny` → 401
- `/v1/hackers/programs` → 401

Verdetto: NESSUN fallback anonimo su api.hackerone.com — `bb sync` richiede
sempre le credenziali utente (ticket credenziali-h1-sync diventa bloccante
per il fetch via API). Fallback EMPIRICAMENTE validato per programmi public:
scrape della pagina HTML hackerone.com/<handle> (già fatto per bcny —
scope, payout e regole estratti con web_extract). Quindi: sync = API con
token; primo avvio senza token = scrape pagina public + warning "crea un
token per sync completo".
