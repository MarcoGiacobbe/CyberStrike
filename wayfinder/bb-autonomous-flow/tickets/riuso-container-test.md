# riuso del container nei test — CHIUSO 2026-09-28

## Perche'

La regola fondamentale del progetto (vedi `REGOLE-FONDAMENTALI.md`) e': mai
container su container, e al termine di ogni test il container va interrotto
esplicitamente. La prima meta' e' stata rispettata, la seconda no: `V14` e
`V16` non avevano un trap di cleanup, e ogni invocazione di `run-sandbox.sh`
avviava un container nuovo che restava su fino alla fine dello script.

## Cosa e' stato fatto

`run-sandbox.sh` ha un flag nuovo `--keep`:

- se il container esiste gia' ed e' vivo, si entra con `docker exec`;
- se non esiste, si avvia **detached** con `sleep infinity` e poi si entra
  subito con `exec` (senza questo, `docker run -d` avvia e ritorna: il comando
  non verrebbe mai eseguito);
- controlla che i mount del container riutilizzato corrispondano al programma
  richiesto, altrimenti rifiuta invece di dare un verde bugiardo.

`V14` e `V16` ora usano `--keep` su un container **dedicato e nominato**, e
hanno un `trap` che lo rimuove alla fine, riuscita o fallimento. I container
manuali dell'utente (`cyberstrike-bounty` ecc.) non vengono toccati: il nome
passa da `CYBERSTRIKE_SANDBOX_NAME`.

## Difetti trovati durante il lavoro

1. **`docker run -d` senza `exec` di r-followup**: avviava e ritornava, il
   comando non girava. Il sintomo era un output vuoto piu' l'hash del
   container.
2. **`INNER_SCRIPT` con `$CS_CMD` dentro single quote**: la variabile restava
   letterale e il ramo `test` eseguiva una variabile vuota. Risolto passando
   `CS_CMD` via ambiente (`-e CS_CMD`) invece di interpolarla nella stringa.
3. **Sostituzione testuale `${var//@@CS_CMD@@/$CS_CMD}`**: in bash, `&` nella
   sostituzione significa "tutto cio' che ha matchato il pattern". Un comando
   con `&&` diventava `@@CS_CMD@@@@CS_CMD@@` e i `&&` sparivano; con
   `2>/dev/null` spariva il redirect. L'errore e' silenzioso: il container
   eseguiva un comando **diverso** da quello scritto, e il test poteva essere
   verde per il motivo sbagliato. Risolto con l'ambiente.

## Difetti trovati dalla review avversariale (subagent, 2026-09-28)

Il subagent ha trovato due difetti reali, entrambi **riprodotti da me** prima di
correggerli. Vanno nel ticket: sono la parte importante del lavoro.

### 1. Il controllo dei mount era aggirabile (run-sandbox.sh)

Il codice verificava solo la **destinazione** del mount
(`/work/bugbounty/programs/<programma>`), mai la **sorgente**. Un container
avviato con una directory diversa montata su quella identica passava il
controllo, e `--keep` ci entrava tranquillo.

```text
rc=0   WRONG_SOURCE     # --program bcny su mount fabolti
rc=0   WRONG_SOURCE     # senza --program: il controllo NON girava affatto
```

Controprova col fix, stesso scenario:

```text
rc=2   RIFIUTO: i mount sono scelti all'avvio e non cambiano con exec
rc=2   (atteso 2)
```

Il caso senza `--program` era un bypass aggiuntivo, ora chiuso: senza programma
non si riusa.

### 2. `trap cleanup TERM` non puliva (verify-v16, verify-v14)

`trap cleanup EXIT INT TERM` sembrava coprire tutto. Non e' vero: in bash il
trap del chiamante **non gira** mentre un `docker exec` e' in foreground.
Dopo SIGTERM `docker inspect` rispondeva ancora `Running: true`.

Ho provato un watchdog in userspace e **non funziona**, per una ragione che
vale piu' del fix: uccidendo il padre con SIGKILL questo resta zombie, e su uno
zombie `kill -0` continua a rispondere "vivo". Il watchdog aspetta un processo
che per definizione non morira' mai.

```text
meccanismo isolato:  WATCHDOG-FIRED        (funziona)
nel caso reale:     container ancora Up   (non funziona)
```

La soluzione non e' un altro processo utente, perche' **nessun processo utente
puo' garantire la pulizia dopo un SIGKILL**. La leva e' dentro il container:
il ciclo di attesa non e' un `sleep infinity` muto, ma un ciclo che esce da
solo se nessuno lo tocca da `KEEP_IDLE_SEC`.

```text
marker invecchiato di 20 minuti -> Exited (0) 7 seconds ago
```

Ora anche l'interruzione piu' brutale lascia il container vivo per AL PIU'
`KEEP_IDLE_SEC` (15 minuti), poi muore da solo. Il `trap` resta per la via
rapida, ma non e' piu' l'unica rete.

Nota: il container si auto-termina ma non si auto-rimuove (niente `--rm` con
`-d`). Resta in `Exited`, non occupa memoria e non e' piu' riusabile: il test
successivo lo rimuove e riparte pulito.

## Controprova

4 invocazioni di `run-sandbox.sh` sullo stesso programma:

| invocazione | container creati |
|---|---|
| con `--keep` | **1** |
| senza `--keep` | **4** |

## Falso verde chiuso in V14

Il probe scrive un marker `v14-positivo-<pid>.txt` e rimuove **solo il
proprio**. Il wrapper pero' verificava con un glob che matchava **qualsiasi**
`v14-positivo-*`. Un residuo di un run precedente rendeva `PASS` un mount in
sola lettura.

Controprova eseguita: piantato a mano `v14-positivo-9999.txt` e tolta la
pulizia, il test ha stampato `V14: PASS` usando un file **non creato dal run
corrente**. Con la pulizia (che ora avviene *prima* del probe, e anche nel
trap) il caso non si presenta piu'.

## Cosa NON e' stato fatto

- `V14` chiama `run-sandbox.sh` anche per programmi diversi (`link1`,
  `link2`), e su quelli il riuso viene **rifiutato** di proposito: i mount non
  corrisponderebbero. E' il comportamento corretto, non un difetto.
- V14/V16 non avviano piu' di un container per esecuzione, ma non traggono
  beneficio dal riuso quanto V16: le loro invocazioni condividono gia' il
  nome. Il flag serve per i test che chiamano piu' volte con programmi diversi.
