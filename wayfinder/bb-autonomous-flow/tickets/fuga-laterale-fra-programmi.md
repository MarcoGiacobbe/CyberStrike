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

## Disegno della correzione (`deleg_5b020b7c`, 2026-09-27)

### Le tre opzioni, valutate

**a) Il launcher riceve il programma prima di avviare il container. REGGE** —
e' l'unica che chiude davvero, a condizione di non montare la root larga nemmeno
in sola lettura.

Il costo reale: oggi `./run-sandbox.sh shell` avvia una shell senza sapere quale
programma verra' usato, e `run "messaggio"` non puo' dedurre il programma dal
messaggio in modo sicuro. Quindi serve un selettore esplicito, per esempio
`./run-sandbox.sh --program bcny shell`, piu' una modalita' generica senza dati
bug bounty per quando il programma non e' indicato.

**b) Root larga in sola lettura. FALSA CORREZIONE.** Blocca la riscrittura ma
lascia leggibili `credentials.json` e i config degli altri programmi: per la
riservatezza dei segreti non chiude niente. Inoltre renderebbe in sola lettura
anche `programs/`, che e' dove si lavora: servirebbe comunque un mount
separato in scrittura per la directory del programma.

**c) Accettare e documentare il rischio. Non riduce niente** — cambia solo la
descrizione. E' una scelta legittima solo come accettazione esplicita, non come
chiusura del difetto.

### Cosa deve poter leggere `bb hunt`, verificato nel codice

- `cli/cmd/bb.ts:659-669` — `/work/bugbounty/<programma>.json`, per il config e
  per sapere se il programma e' sincronizzato
- `cli/cmd/bb.ts:680-689` — la directory `programs/<programma>/`, che deve
  essere in **scrittura** perche' e' la directory di progetto
- `session/bounty-state.ts:127-160` — `programs/<programma>/state.json`, opzionale

**Non serve al bootstrap:** `<programma>.accounts.json` e `<programma>.policy.md`.
E `credentials.json` non deve essere montato, **nemmeno in sola lettura**.

### Il vincolo che rende la correzione incompleta

La registrazione automatica degli account legge le credenziali globali:

- `packages/hackbrowser/src/accounts.ts:87-109` -> `credentials.json`
- `packages/hackbrowser/src/bugbounty.ts:237-255` — la lettura

Separare i mount chiude la fuga laterale ma **disattiva questa funzione**. Non
esiste una credenziale alternativa limitata al singolo programma. Va deciso:
progettare credenziali per-programma, o rinunciare alla registrazione
automatica dentro il container.

### La trappola, da evitare esplicitamente

1. Estendere il perimetro a tutta `BB_ROOT`: l'agente non esce piu' dal mount ma
   continua a leggere i file montati. Non separa niente.
2. Mettere `credentials.json` in sola lettura: protegge dalla modifica, non
   dalla lettura. Il segreto che basta e' il contenuto, non la scrittura.

La correzione deve limitare **quali file esistono nel container**, non quali
operazioni il perimetro dichiara consentite. Il launcher deve anche validare il
nome del programma e montare path costruiti esattamente da quel nome, non path
liberi dall'argomento.

### Effetto collaterale: `bb list` si rompe

`cli/cmd/bb.ts:404-419` chiama `listPrograms()`, che legge tutti i JSON nella root
con `readdirSync` (`packages/hackbrowser/src/bugbounty.ts:107-115`). Con il mount
dei soli file di un programma, `bb list` mostrera' solo quelli montati. Va
deciso: non offrire l'elenco completo nel container limitato, oppure passare un
elenco separato di soli nomi, senza i file.

## Test di chiusura (non eseguito: il vincolo di risorse lo impediva)

1. **Controllo positivo:** scrivere con contenuto univoco in
   `programs/bcny/`, l'host deve trovarlo con lo stesso contenuto.
2. **Credenziali assenti, non negate:** sull'host verificare che
   `credentials.json` esista *prima*; poi con il container attivo
   `docker inspect <c> --format '{{json .Mounts}}'` e verificare che non ci sia
   il mount della root ne' quello del file; dentro il container
   `test ! -e /work/bugbounty/credentials.json`. L'assenza del file e' la prova,
   il fatto che l'agente non l'abbia letto no.
3. **Controllo negativo fra programmi:** scrivere in `programs/bcny-test/` deve
   fallire e sull'host il file non deve comparire; `docker inspect` non deve
   mostrare un mount piu' ampio di `programs/`.
