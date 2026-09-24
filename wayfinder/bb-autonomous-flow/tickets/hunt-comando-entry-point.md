# Ticket: comando `bb hunt` — entry point del progetto di hunting

## Question

Introdurre `cyberstrike bb hunt <program>`: il comando che apre una sessione di
hunting per un programma, con contesto iniettato e perimetro di scrittura
confinato al progetto. È l'entry point del flusso a 4 step della MAP.

## Context

Oggi NON esiste: nessun comando `hunt`, nessun concetto di "progetto di
hunting". Le primitive esistono tutte ma sono scollegate:

- `bb sync <program>` → scarica scope/payout/policy (fatto, funziona)
- `program.json` su disco in `~/.cyberstrike/bugbounty/<handle>.json` (fatto)
- `accounts.json` via `bb accounts` (fatto)
- `prompt/bugbounty.txt` (15.624 byte) — overlay prompt (fatto, non iniettato)
- `cyberstrike run "msg" --agent <agente>` — sessione con messaggio (esiste)
- agenti: `web-application` (bash/hackbrowser/webfetch/report_vulnerability/
  triage_vulnerability/scope_check/methodology_status + skill WSTG) — esiste
  già e NON va reinventato

Decisioni utente (2026-09-24, questa sessione):
- Nome: **`cyberstrike bb hunt <program>`** (resta nel namespace `bb`)
- Il progetto contiene il programma (sincronizzato, sovrascrivibile) + stato di
  hunting separato (fase, target toccati, vuln, account)
- Vincolo scrittura confermato: solo scrittura confinata, lettura libera
  (read è già `allow` e non va toccata)

## Comportamento atteso

```
cyberstrike bb hunt bcny
  ├─ progetto esiste in ~/bugbounty/bcny/ ?  → no → lo crea (bootstrap)
  ├─ program.json aggiornato?                → no → avvisa/invita a `bb sync bcny`
  ├─ carica lo stato (fase, target toccati, vuln, account)
  ├─ apre sessione con agente bounty + perimetro = solo quella dir
  └─ messaggio iniziale: scope in/out, regole, payout, known issues,
     header richiesti dal programma, fase corrente, cosa resta, toolset
```

Idempotenza richiesta: rilanciato a metà non deve duplicare nulla, deve
riprendere e dire cosa è stato fatto l'ultima volta.

## Dipendenze

- [struttura-directory-progetto] (deciso, non implementato)
- [sandbox-scritture-perimetro] (nuovo ticket) — il perimetro è prerequisito
- [stato-progetto] (nuovo ticket) — cosa legge il comando per il contesto
- [agente-bounty-prompt-iniziale] (nuovo ticket) — l'agente e il messaggio

## Da decidere

1. Il comando è un wrapper su `run --agent` o un path dedicato?
   (run esiste e accetta `--agent`; potrebbe bastare, ma serve iniezione di
   contesto + forzatura del perimetro, che `run` non fa)
2. Cosa succede se il progetto esiste ma il programma è stato rimosso
   (`bb remove`)? Il progetto resta orfano — warning o blocco?
3. Il bootstrap crea anche il primo `crawl` o si ferma al contesto?
4. Se l'utente lancia `bb hunt` da dentro un'altra directory, il progetto
   resta in `~/bugbounty/<prog>/` o si crea dove sta?
   (la decisione presa dice `~/bugbounty/<programma>/` — confermare)
5. `bb hunt --dry-run` che mostra il messaggio iniziale senza aprire sessione:
   serve per debug/verifica? (io dico sì, costa poco)