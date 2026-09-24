# Ticket: Credenziali API HackerOne per il sync (HITL)

## Question

Il fetch automatico (bb sync) richiede un API token HackerOne dell'utente.
Generarlo è manuale (hackerone.com → Settings → API Tokens). L'utente deve
crearne uno e passarlo — dove? `bb connect --api-identifier/--api-token`
già esiste (salva in credentials.json chmod 600).

## Context

HITL: solo l'utente può farlo (è il suo account). Tutto il resto del flusso
può essere AFK. Alternativa AFK parziale: per programmi PUBLIC lo structured
scope a volte è leggibile senza token — da verificare nel sync (curl senza
auth su /v1/hackers/programs/bcny/structured_scopes).

## Azione

- [ ] Utente: genera API token su HackerOne (Settings → API Tokens)
- [ ] Utente: `bb connect --api-identifier <id> --api-token <token>` (o env vars)
- [ ] Verifica E2E: `bb sync bcny` scarica scope/policy reali
