# Fuga laterale fra programmi: BB_ROOT montata rw espone le credenziali di tutti

**Aperto 2026-09-27. Priorita' ALTA. Scoperto dalla verifica V11.**

## Il difetto

Il launcher monta la root del bug bounty in lettura-scrittura:

```
run-sandbox.sh:129
  -v "$BB_ROOT":/work/bugbounty:rw
```

E dentro `BB_ROOT` ci sono i config di **tutti** i programmi, non solo di quello
in caccia:

```
~/.cyberstrike/bugbounty/
  credentials.json      600   <- credenziali di TUTTI i programmi
  bcny.json             664
  smoketest.json        664
  bookingcom.json       664
  security.json         664
  programs/             <- bcny E bcny-test insieme, nella stessa mount rw
```

Il perimetro applicato da `bb hunt` copre `programs/bcny/`. Ma il mount copre
tutta la root. Quindi un agente che lavora su `bcny`:

- puo' leggere `credentials.json` e ottenere i segreti di ogni altro programma;
- puo' **riscriverlo** (il mount e' rw e il file e' del proprietario);
- puo' leggere e riscrivere `bookingcom.json`, `smoketest.json`, ecc.;
- puo' scrivere dentro `programs/bcny-test/` mentre lavora su `bcny`.

Non e' un escape dal container. E' un agente che opera su un perimetro piu'
ampio di quello dichiarato, e che puo' raggiungere i segreti di programmi non
assegnati.

## Perche' e' la piu' grave delle due fughe trovate da V11

L'altra fuga (home del container scrivibile) permette di scrivere file temporanei
in un posto che scompare col container. Questa permette a un programma di
leggere le credenziali di un **altro programma** — che in un workflow bug bounty
significa prendere il controllo di un target che non e' tuo, o farlo sembrare
tua un'attribuzione.

## La correzione non e' --read-only

`--read-only` sul container renderebbe CyberStrike inutilizzabile: il TUI scrive
in `/home/hunter/.local` (volume `cyberstrike-share`) e in `/work`. La risposta
e' **montare piu' directory strette invece di una larga**:

| cosa | oggi | dopo |
|---|---|---|
| `programs/<programma>` | dentro una mount rw larga | mount rw dedicata |
| `BB_ROOT` intera | rw | ro, o non montata |
| `credentials.json` | montato, rw | **mai montato** |
| `<programma>.json` | montato | montato, ro |
| `<programma>.accounts.json` | montato | montato, ro |
| `<programma>.policy.md` | montato | montato, ro |

## Il vincolo che rende la cosa non banale

`bb hunt` risolve i config del programma dalla root perche' li conosce solo a
runtime (il nome del programma arriva dall'utente come argomento). Passare a un
mount per-programma richiede di sapere il nome **prima** di avviare il
container. Opzioni:

1. il launcher prende il programma come argomento e monta lui i file giusti
   (`./run-sandbox.sh run bcny "messaggio"`), senza che `bb hunt` debba
   risolvere nulla;
2. si mantiene la mount larga ma si passa a mount `ro`, e si affronta
   esplicitamente che la fuga laterale in lettura resta;
3. si accetta la fuga e la si documenta come rischio noto del modello di
   minimo privilegio.

**Opzione 1 e' l'unica che chiude davvero.** Le altre due la riducono o la
documentano. Serve una decisione dell'utente, perche' cambia l'interfaccia del
launcher.

## Criterio di chiusura

- [ ] un agente su `bcny` non legge `credentials.json` (provare dall'host che
      il file non e' raggiungibile nel container, non solo che il perimetro lo
      neghi)
- [ ] un agente su `bcny` non vede `bookingcom.json` ne' `smoketest.json`
- [ ] un agente su `bcny` non scrive in `programs/bcny-test/`
- [ ] il test ha un **controllo positivo**: lo stesso tool scrive con successo
      dentro `programs/bcny/`, altrimenti "non ha scritto fuori" non prova niente
- [ ] `bb hunt <programma>` continua a funzionare (V12 resta verde)
