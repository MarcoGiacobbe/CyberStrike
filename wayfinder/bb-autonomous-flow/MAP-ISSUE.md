# Map: Bug Bounty Autonomous Flow — una sola fonte di verità

> **Questa issue non contiene la mappa. La mappa è un file nel repo:**
> [`wayfinder/bb-autonomous-flow/MAP.md`](https://github.com/MarcoGiacobbe/CyberStrike/blob/feat/bug-bounty-enhancement/wayfinder/bb-autonomous-flow/MAP.md)
>
> Due copie tenute allineate a mano divergono sempre: non è un problema di
> attenzione, è la struttura del problema. Questa issue è una **vista**, non una
> copia. Per leggerla oggi: apri il file.

## Perché l'issue esiste

Il file è la versione lunga e consultabile (175+ righe, ticket, tabelle di
verifica). L'issue serve a due cose:

- **dare accesso alla mappa da GitHub** senza clonare il repo
- **essere il posto dove si discute** delle decisioni, con i link ai ticket

## Come si modifica

```bash
# 1. modifica il file
$EDITOR wayfinder/bb-autonomous-flow/MAP.md

# 2. pubblica e verifica
./infra/bounty-sandbox/sync-map-issue.sh push
```

**L'issue non si modifica mai a mano.** Se lo fai, il workflow
[map-issue-sync](https://github.com/MarcoGiacobbe/CyberStrike/actions/workflows/map-issue-sync.yml)
fallisce al prossimo push che tocca la MAP e ti dice di riallineare.

## Indice delle sezioni (le trovi tutte nel file)

| Sezione | A cosa serve |
|---|---|
| Destination | il flusso che `bb hunt` deve realizzare |
| **Stato reale (misurato)** | cosa funziona e cosa no, con la misura |
| Notes | vincoli dell'utente, primitive esistenti |
| Decisions so far | una riga per ticket, con stato e link |
| Dipendenze fra i ticket | l'ordine di implementazione |
| Verifica — arretrati | V1–V12, cosa manca e perché |
| Not yet specified / Out of scope | i confini dichiarati del lavoro |
| Disallineamenti trovati | cosa era incoerente e cosa è stato corretto |

## Ticket aperti

- #12 Sandbox: l'agente dentro il container (FASE 2-3)
- #14 Difetto: schermo vuoto dopo l'invio del messaggio
- #15 Difetto: il container perde i dati a ogni avvio
- #13 Verifica indipendente: container + perimetro (V11) — **non prioritaria**
- #8 Ticket: Orchestrator del flusso — del 24/09, **non riflette i fatti del 26/09**

## Ticket chiusi (verifica indipendente fatta)

V7, V8, V9, V10 → `tickets/verifica-*.md` nel repo.
