# browser-crash-dentro-sandbox — CHIUSO 2026-09-28

## Il sintomo

Dentro `cyberstrike-bounty:sandbox` il browser di hackbrowser non parte:

```
/bin/bash: line 1: 18 Trace/breakpoint trap (core dumped) chromium ...
rc=133
chrome_crashpad_handler: --database is required
```

Il TUI risultava "muto" anche perche' `preflightCheck()` passava gia': Chromium
esiste in `/usr/bin/chromium` e `findSystemChrome()` lo trova. Il crash era
piu' in basso, al momento del lancio vero.

## La causa vera (isolata per differenza)

Non era `HOME`, non era `/dev/shm`, non era `--disable-dev-shm-usage` (gia'
presente in `LAUNCH_ARGS`), non erano le capability.

Era il **mount**:

```
-v cyberstrike-config:/home/hunter/.config/cyberstrike:rw
```

Docker crea i padri mancanti **come root uid 0**. Il container gira come
`hunter` uid 1000, quindi:

```
drwxr-xr-x 3 0 0 4096 /home/hunter/.config          <- root
uid=1000(hunter) gid=1000(hunter)
mkdir: cannot create directory '/home/hunter/.config/prova': Permission denied
```

Chromium/crashpad non riesce a scrivere il suo database in `$HOME/.config` e
muore prima di aprire una pagina.

Isolamento per differenza (tutti rc raccolti):

| caso | rc |
|---|---|
| `docker run` puro, nessun mount | 0 |
| singolo flag (`--cap-drop=ALL`, `no-new-privileges`, `pids-limit`, `--memory=2g`, `--shm-size=1g`, `-u 1000:1000`) | 0 |
| tutti i flag insieme | 0 |
| `/app:ro` + workdir | 0 |
| mount `cyberstrike-config` a path nuovo, senza XDG | 0 |
| `XDG_CONFIG_HOME=/…/csconfig` da solo | 0 |
| **`XDG_CONFIG_HOME` + volume su quel path** | **133** |

L'ultima riga e' la chiave: da sola la variabile non basta, da solo il volume
non basta, insieme crashano. Il volume alla root della dir XDG e' 1000-owned;
un livello piu' in dentro, il padre lo crea Docker come root.

`chown` non e' una strada: con `--cap-drop=ALL` si ottiene
`chown: Operation not permitted`, anche da `docker exec -u 0`.

## Il fix

1. `run-sandbox.sh`: i volumi si montano **alla root** delle dir XDG
   (`-v VOL_CFG:/home/hunter/csconfig`), non un livello dentro. Nessuna directory
   sotto `$HOME` dipende piu' da Docker.
2. `run-sandbox.sh`: esplicite `HOME` e le quattro `XDG_*`, cosi' il codice le
   trova dove le cerca (`xdg-basedir` le rispetta) e Chromium ha una dir
   scrivibile dove mettere crashpad e profilo.
3. `packages/hackbrowser/src/stealth.ts`: `prepareHome()` crea `$HOME/.config`
   prima di lanciare. Serve per l'HOST, dove la home puo' essere vuota: e' lo
   stesso crash fuori dal container. Da solo pero' **non** risolveva il sandbox
   (falliva con EACCES) — la fix del launcher e' quella vera.

## Cosa ho sbagliato, e va scritto

- **Falso positivo riciclato come diagnosi.** Un comando con `HOME=/tmp/h` era
  tornato `rc=0` e l'ho preso per la prova che `HOME` fosse la causa. Ho scritto
  il patch su quella base. Ripetendo i tre casi nello stesso setup, tutti e tre
  crasavano: il mio "caso che funzionava" non funzionava.
- **Dichiarato risolto senza eseguire nel container.** Dopo il primo patch in
  `stealth.ts` ho scritto che il crash era risolto; girando V17 dentro il
  sandbox il crash c'era ancora, perche' `mkdir -p $HOME/.config` finiva in
  EACCES.
- **`--user-data-dir` a `chromium.launch()`** e' rifiutato da Playwright:
  `Pass userDataDir parameter to 'browserType.launchPersistentContext(...)'
  instead of specifying '--user-data-dir' argument`. E non si puo' tornare
  indietro facilmente: `launch()` dà un `Browser`, `launchPersistentContext()`
  un `BrowserContext`, e i caller usano `browser.newPage()`. Il default di
  Playwright va bene: il crash non era del profilo.

## Verifiche

- V17 (nuovo, permanente): lancia `connect()` di stealth.ts dentro il container
  e apre una pagina vera.
  - col fix: `V17: PASS`, `h1="BB-OK-DAL-CONTAINER"`.
  - a `HEAD` (run-sandbox.sh riportato indietro): `V17: FAIL (2)` su
    `HOME/.config assente o scrivibile` e `browser lanciato senza crash`.
  Il test misura: rosso senza fix, verde col fix.
- Chromium grezso dentro il launcher corretto: `<html>…<h1>X</h1></html>`, rc=0.
- `XDG-SCRIVIBILE` con volume 1000-owned.
- V14 `PASS`, V16 `PASS` dopo il cambio dei path dei volumi.
- typecheck 11/11, suite 949 test / 0 fail.
- Nessun container residuo a fine ogni run.

## Note per chi riprende

- Il test V17 sta in `packages/hackbrowser/test/v17-browser-in-sandbox.ts` ed e'
  uno script standalone, non un file `bun test`: non gira nella suite perche'
  vuole un container con Chromium e ci mette ~90 s. Si lancia dentro il sandbox:
  `cd /app/packages/hackbrowser && bun test/v17-browser-in-sandbox.ts`.
- Non spostare i volumi di un livello piu' in dentro senza rifare la bisectione:
  e' esattamente quello che riporta il crash.
