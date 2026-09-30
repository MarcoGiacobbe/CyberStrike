# Esecuzione di `bb hunt bcny` — la directory del programma è il progetto

> Simulazione costruita con i dati reali di `~/.cyberstrike/bugbounty/bcny.json`.
> Il codice NON è ancora cambiato: oggi l'output è diverso da questo.

---

## Caso 1 — programma noto e dati freschi (≤ 24 h)

```
$ cyberstrike bb hunt bcny

  bcny · HackerOne · dati aggiornati 3 ore fa

  /home/marco/.cyberstrike/bugbounty/programs/bcny

  Il TUI si apre qui dentro.
```

**Cosa l'utente vede:** un comando, una riga di stato, il percorso. Niente domande.

**Cosa l'agente riceve prima di ogni altra cosa (prompt di sistema):**

```
Instructions from: /home/marco/.cyberstrike/bugbounty/programs/bcny/AGENTS.md

# Sei in una caccia a bug su bcny (The Browser Company)

Programma: HackerOne — https://hackerone.com/bcny
Dati sincronizzati: 2026-09-29T09:14:00Z (freschi)

## Cosa non toccare MAI
- Scope OUT. Se un asset compare in `scope.md` sotto "NON in scope", non lo tocchi.
- Nessun asset che non sia in `scope.md` sotto "In scope".
- Nessun asset non-URL senza URL reale: "Dia Assistant", "Arc on Mac",
  "id6472513080" sono nomi di prodotto, non indirizzi. Vedi `scope.md`.
- Nessun test di devastazione, carico o denial of service. Questo è un programma
  con pagamenti fino a $20.000 e l'utente è dalla parte buona: un programma
  respinto per danni è un danno irreversibile.

## Tetto di richieste
- max steps: 6 per target (dal programma)
- massimo 200 richieste per asset, poi fermati e riporta

## Prima di toccare un target, leggi
- `scope.md`   — cosa è in scope, cosa no, e quanto paga ogni asset
- `policy.md`  — il testo del programma, per intero. Non indovinare le regole:
  il testo integrale è qui, non un estratto.

## Come lavorare
- Solo il perimetro: puoi leggere ovunque, scrivi solo in questa directory.
- Un report vive di una prova riproducibile. Un sospetto non è un report.
- Fuori scope significa "nessun rapporto", non "nessun test". Puoi testare un asset
  fuori scope per capire se è lo stesso asset, ma non puoi riportarlo.
- Quando trovi qualcosa: `bounty_status` per lo stato, poi il report.
```

**Nota:** l'`AGENTS.md` entra **automaticamente** nel prompt di sistema a ogni
sessione (`src/session/instruction.ts:71-116`). Non sta nel messaggio iniziale,
per sua natura: è istruzioni de

---

## Caso 2 — programma mai sincronizzato

```
$ cyberstrike bb hunt nuovoprogramma

  nuovoprogramma · non ancora sincronizzato
  → sincronizzo ora…

  ✓ sincronizzato in 4,2 s · 14 asset in scope · payout $100 – $20.000

  /home/marco/.cyberstrike/bugbounty/programs/nuovoprogramma
```

**Cosa succede in sequenza:** `bb hunt` fa il sync da solo, poi parte. Nessuna
domanda all'utente. Se il programma non esiste su HackerOne, si arriva al Caso 3.

---

## Caso 3 — rete giù, dati vecchi (il caso che conta)

```
$ cyberstrike bb hunt bcny

  ⚠ non ho potuto aggiornare bcny: connessione fallita
    uso i dati del 12 giorni fa (2026-09-17)

  /home/marco/.cyberstrike/bugbounty/programs/bcny
```

**E nel prompt dell'agente, in testa al messaggio iniziale:**

```
> ⚠ **Dati del programma non freschi.** L'ultimo sync risale al 2026-09-17
> (12 giorni fa) e non ha potuto essere aggiornato. Lo scope qui sotto potrebbe
> essere cambiato: prima di riportare, verifica che l'asset sia ancora in scope.
```

**Perché la riga va anche nel prompt e non solo a terminale.** L'utente la vede
e capisce. Ma l'agente è quello che produce il report: se lui non lo sa, produce
un report su uno scope invecchiato, e il report viene respinto. L'avviso deve
essere dove l'utente lo vede *e* dove l'utente non può arrivare.

---

## I tre file nella directory del programma

```
~/.cyberstrike/bugbounty/programs/bcny/
├── AGENTS.md          ← 2 KB, entra nel prompt di sistema da solo
├── scope.md           ← scope separato URL / non-URL + payout per asset
├── policy.md          ← 12.719 byte, testo integrale
├── state.json         ← fase, target toccati, finding
└── .cyberstrike       ← identificatore del progetto
```

### `scope.md` — la sezione che oggi manca

```markdown
# Scope — bcny

Dati sincronizzati il 2026-09-29. Fonte: HackerOne.

## In scope — URL e domini (5)
| Asset | Payout critical | Payout max |
|---|---|---|
| company.thebrowser.arc | $10.000 | $10.000 |
| thebrowser.company | $1.000 | $1.000 |
| bcny.com | $1.000 | $1.000 |
| arc.net | $1.000 | $1.000 |
| diabrowser.com | $1.000 | $1.000 |

## In scope — NON URL (8)
Nomi di prodotto e asset mobile. **Non sono indirizzi: non provare a costruirci
un URL e non trattarli come target web.**

| Asset | Payout critical |
|---|---|
| Dia on MacOS | $20.000 |
| Dia on Windows | $20.000 |
| Arc on Window | $20.000 |
| Arc on Mac | $20.000 |
| Dia Assistant | $5.000 |
| id6472513080 | $10.000 |
| Dia Browser | — |
| Arc on Windows | — |

## Out of scope
(il programma non ne dichiara)

## Come usare questo file
- Gli asset in "NON URL" sono il cuore del programma: 4 dei 5 più pagati sono
  prodotti desktop, non siti web. Un agente che li scambia per URL spende il
  suo tempo sui 5 domini da $1.000 e ignora i $20.000.
- I payout sono per severità: `crit` = severità critical.
- I domini da $1.000 esistono per non far sembrare il programma vuoto. Il valore
  è nei prodotti desktop.
