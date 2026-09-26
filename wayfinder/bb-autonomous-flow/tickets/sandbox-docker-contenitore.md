# Ticket: contenimento a livello kernel — l'agente dentro un container

## Stato: FASE 1 MISURATA (2026-09-26) — immagine costruita, fuga provata, nessuna fuga

`cyberstrike-bounty:sandbox` costruita (debian:bookworm-slim, tool di hunting,
`docker` assente, utente `hunter` non-root). `escape-test.sh` eseguito davvero
con `--cap-drop=ALL --security-opt=no-new-privileges --pids-limit=256
--memory=2g`: **6 fughe tentate, 0 riuscite** — `/etc`, `/home/marco`, `/root`,
chiavi SSH, socket Docker, riferimenti all'host. `CapEff: 0000000000000000`.
`/work` scrivibile (la sandbox serve a qualcosa). Tutti i tool presenti.

**Questo è V11 chiuso per la parte filesystem** — e resta la verifica
indipendente (vincolo di progetto): i test dell'autore non contano. Rimane la
FASE 2 (TUI dentro il container) e la FASE 3 (cablaggio nel fork).

## Decisione utente (verbatim)

> "Dentro il container può fare quello che vuole, però se si organizza bene le
> cartelle di lavoro sarebbe meglio. Io vorrei tutto l'agente dentro il
> container non solo bb hunt!"

Due scelte, entrambe da onorare:

1. **L'agente ha libertà totale *dentro* il container.** Il confine non è
   "quali comandi sono permessi": è "dove il container può arrivare". `rm -rf /`
   dentro il container cancella il container. Va bene, è il punto.
2. **Cartelle organizzate.** Non tutto `/work` è scrivibile: la struttura sotto
   distingue *dove l'agente lavora* da *cosa l'agente legge*.
3. **Tutto l'agente, non solo `bb hunt`.**

## Perché questo ticket esiste (e cosa chiude)

V6 era un limite dichiarato: "non è un contenimento a livello kernel, è un gate
applicativo". Il perimetro in JS è una lista di pattern **dentro lo stesso
processo che l'agente controlla**. Un gate che sta dove sta l'avversario non è
un confine, è una richiesta educata.

Conseguenza diretta, e questa è la parte che giustifica il ticket: **quella
semantica è la causa di G4.** `boundaryDenies` confronta solo l'area e ignora il
pattern, quindi un deny stretto uccide allow lecite. Ho corretto quella
funzione **tre volte in due direzioni opposte** prima di capire che la domanda
("l'utente può autorizzare un'azione fuori?") è sbagliata: dentro un container
la risposta è costante, perché *fuori* non è raggiungibile.

V6 → risolto **per via d'impianto**, non per codice.
G4 → **privo di soggetto** (non serve scegliere (a) o (b): le due letture
divergono solo perché esiste un "fuori" da autorizzare).

## Punto d'innesto: una riga

```ts
// packages/cyberstrike/src/tool/bash.ts:312
const proc = spawn(params.command, {
  shell, cwd, env: { ...process.env, ...shellEnv.env },
  stdio: ["ignore", "pipe", "pipe"],
})
```

Oggi quel `spawn` esce sull'host. È **l'unico** punto da cui esce un comando
del tool bash. Wrappare qui (o far girare l'intero processo TUI nel container)
copre ogni comando, presente e futuro, senza lista di eccezioni.

**Perché "tutto l'agente" è la scelta giusta e non solo `bb hunt`:** il TUI è già
un processo separato. Se quel processo gira dentro il container, il confine
vale per **tutti** gli agenti — `web-application`, `explore`, `plan`, quello
bounty — senza codice per-agente. Il percorso minimo è lanciare il TUI dentro;
`bb hunt` dentro un container dedicato è il caso *facoltativo*, utile solo per
isolare programmi diversi l'uno dall'altro.

## Struttura delle cartelle

```
/work/programmi/<programma>/   rw  ← l'unica zona scrivibile
    scope/  notes/  reports/  crawls/
/work/sorgenti/                ro  ← i sorgenti/crawls del target: si LEGGONO
/tmp/                          rw  ← il banco di lavoro (i tool ne hanno bisogno)
/home/                          rw  ma VUOTO: il tuo /home/marco non è montato
```

Il punto che chiude il patto: **`/home/marco` non è montato**. Quindi "scrivere
fuori dal progetto" non è una regola che l'agente deve rispettare, è una
posizione in cui non si trova. Da qui la lettura libera: se serve leggere
qualcosa dell'host, si monta in `:ro` — esplicito e reversibile.

## Vincoli (default, da confermare)

| Flag | Valore | Perché |
|---|---|---|
| `--cap-drop` | `ALL` | niente sollevamento privilegi |
| `--security-opt` | `no-new-privileges` | blocca l'escalation via setuid |
| `--pids-limit` | `256` | un `fork` bomb non mangia l'host |
| `--memory` | `2g` | l'host ha 14G, 5G liberi: un container può prenderne metà |
| `--network` | `bridge` | **serve**: il hunting esce in rete |
| `docker` nel container | **assente** | altrimenti l'agente avvia container annidati e il confine è gone |

**Il punto scoperto leggendo `project.ts:186`:** `docker` e `podman` sono già in
`WRITE_COMMANDS`, quindi il gate chiede conferma prima di lasciarli girare. Ma se
il binario `docker` è dentro l'immagine, l'agente può lanciarlo comunque. La
decisions è: `/var/run/docker.sock` **non** va montato, e `docker` non va
installato nell'immagine. `docker` serve solo a te, dall'host.

## Cosa NON risolve — dichiarato prima di costruirla

- **Leggere l'host**: non c'è più lettura libera *gratis*. Serve `:ro` esplicito.
  È il prezzo, ed è il prezzo giusto: è la differenza fra "leggere ovunque" e
  "leggere quello che hai deciso tu".
- **Tool che richiedono raw socket** (`nmap -sS`, `hping`): **MISURATO** — non
  funzionano con `--cap-drop=ALL`. E il rimedio intuitivo è **sbagliato**:
  `--cap-add=NET_RAW` da solo NON basta (`CapEff: 0000000000000000` resta
  azzerato), servono **`--user root` + `--cap-add=NET_RAW` insieme**. Con root +
  NET_RAW `nmap -sS` funziona. La via forte resta `nmap -sT` (TCP connect),
  che è pieno per l'hunting e non chiede privilegi.
  *Il mio test iniziale diceva il contrario* perché guardava `$?` dopo
  `nmap -h`: `-h` non è un target, nmap stampa l'usage ed esce comunque 0. Un
  test che misura l'uscita invece del risultato è un test che mente — corretto
  in `escape-test.sh` (si cerca `Nmap scan report`, non il codice di uscita).
- **Il cracking vero richiede tool installati** nell'immagine: sqlmap, nuclei,
  httpx, ecc. Un'immagine "bounty" è manutenzione, non un Dockerfile di 10 righe.
- **Il confine è comunque kernel** (namespace + mount RO), non magia. È però
  *più* forte del perimetro JS, perché non posso più scrivere dentro il codice
  che lo applica.
- **`bb hunt` in un container dedicato per programma** è un secondo strato, utile
  per non farne collidere due. Non è il primo.

## Fasi

### FASE 1 — immagine + verifica di fuga (V11)
1. `Dockerfile` minimo: base, tool di scanning, `/work` strutturato, `docker`
   assente.
2. **Test di fuga vero**: con il container in piedi, tentare la scrittura in
   `/etc`, `/root`, `~/.ssh`, `/home/marco` e verificare che (a) il file fuori
   **non venga creato** e (b) il ritorno sia **errore**, non `ask`. Questo è
   l'unico test che chiude V6/G4: gli attuali provano che `evaluate` nega, non
   che il path non esiste.
3. Verificare se `nmap` serve `NET_RAW` e scegliere.

### FASE 2 — lancio del TUI dentro il container (IN CORSO)

**Scoperta che cambia la Fase 2**: il bounty agent **è un agente browser**.
`packages/hackbrowser/src/agent.ts:1` importa `playwright`, e
`api.ts:151` fa un preflight che **fallisce se `chromium.executablePath()` non
esiste**. Quindi un container senza browser non è un agente con limiti: è un
**agente muto**, e il fallimento sarebbe un preflight, non un errore di
permessi. Chromium aggiunto all'immagine; `browser-test.sh` verifica che il
browser **parta davvero** e scopre se il suo sandbox interno funziona con
`--cap-drop=ALL` (se non funziona serve `--no-sandbox`: si scopre lì, non a
runtime con un crash generico).

`run-sandbox.sh` monta: repo in `/app` (rw, è il codice), programmi in
`/work/programmi` (rw, i dati), sorgenti in `/work/sorgenti` (ro). Codice e
dati restano separati di proposito: il volume dei programmi deve essere
rimontabile senza toccare il codice.

**Chrome sandbox: MISURATO che è irraggiungibile, e il rimedio intuitivo è
sbagliato.** Dentro il container `unshare --user` fallisce con `Operation not
permitted` (i user namespace sono disabilitati da Docker di default, anche se
sull'host `unprivileged_userns_clone=1`). Chromium esce con `No usable
sandbox!`. Ho provato a togliere `no-new-privileges` per sbloccarlo: **non
cambia** (`rc=1`, stesso errore) — il blocco è sui namespace, non su SUID.
Quindi la difesa costa `--no-sandbox` **a Chromium solo**, e
`--security-opt=no-new-privileges` resta attivo: è la difesa più forte
disponibile, il browser perde il suo sandbox *interno*, non il confine del
container. Browser verificato funzionante: `Chromium 154.0.8037.57`, headless,
rendering DOM OK.

### FASE 3 — cablaggio nel fork
`bb hunt` (o un flag di avvio) che lancia la sessione nel container giusto.

## Criterio di chiusura

Non "il container parte". Il criterio è **V11**: un tentativo di fuga reale
fallisce a livello di filesystem, non a livello di pattern. Fino ad allora
questa è un'ipotesi ben motivata, non una difesa.

## Verifica richiesta (vincolo di progetto)

Ogni verifica di sostanza passa da **subagent indipendente con mandato
avversariale**. Per questa ticket il mandato è scrivibile: *provare a fuggire
dal container e dire cosa è riuscito*. I test dell'autore non contano.
