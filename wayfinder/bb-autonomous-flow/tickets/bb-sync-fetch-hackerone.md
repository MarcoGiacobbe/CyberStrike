# Ticket: bb sync — fetch reale da HackerOne API

## Question

Implementazione concreta di `bb sync <program>`: endpoints, mapping
structured_scopes/policy/hacktivity → program JSON, gestione 403/404 per
programmi non partecipati, fallback scrape via BrowserSkill.

## Context

Ricerca già fatta (BUG_BOUNTY_PLAN.md): Hacker API con Basic Auth token
(H1_API_IDENTIFIER/H1_API_TOKEN o `bb connect --api-*`), endpoints:
- GET /v1/hackers/programs
- GET /v1/hackers/programs/{handle} (policy = regole)
- GET /v1/hackers/programs/{handle}/structured_scopes (scope + eligible_for_bounty)
- Hacktivity filtrato per handle (known issues)
Rate limit: 600/min read, structured_scopes 50/min. Serve token utente
(HITL: l'utente deve generarne uno su hackerone.com/settings).

## Da decidere

- Salvataggio grezzo API (raw/ nel progetto) per re-parse futuri: sì/no?
- Payout precise: API non le dà sempre — fallback scrape pagina o placeholder?
- known issues: quante (ultime N divulgazioni) e come filtrare per rilevanza?
