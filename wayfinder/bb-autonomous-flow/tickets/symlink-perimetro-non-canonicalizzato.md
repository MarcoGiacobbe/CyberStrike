# Symlink: il controllo del perimetro non canonicalizza il path

**Aperto 2026-09-27. Non ancora testato a runtime — questa e' un'analisi del
codice, non una riproduzione.**

## Il sospetto

`assertExternalDirectory` confronta il path richiesto con il perimetro **senza
risolverlo**:

```
packages/cyberstrike/src/tool/external-directory.ts:17
  -> Instance.containsPath(...)      filesystem.ts:35-36
```

`containsPath` lavora sulla stringa del path. Se dentro
`programs/bcny/` c'e' un symlink `fuori -> /etc`, e l'agente scrive su
`programs/bcny/fuori/pasd`, il path richiesto e'`programs/bcny/fuori/pasd`:
contenuto, perimetro rispettato, autorizzazione concessa. La scrittura pero'
segue il link e finisce in `/etc/pasd`.

`apply_patch` normalizza i `..` con `path.resolve` (`apply_patch.ts:61`) ma
`path.resolve` non segue i symlink. Stessa cosa.

## Perche' conta piu' di quanto sembri

Con `BB_ROOT` montata `rw` (vedi [fuga-laterale-fra-programmi.md](fuga-laterale-fra-programmi.md)),
l'agente puo' **crearsi da solo il symlink**: non deve trovarlo gia' pronto.
Basta un symlink dentro la propria directory di programma che punta a
`../..`, e da lì il perimetro non ferma piu' niente.

E' il buco che trasforma "l'agente puo' scrivere dove deve" in "l'agente puo'
scrivere ovunque", senza bisogno di altre tecniche.

## Cosa NON e' stato verificato

Non ho riprodotto la fuga. Il ragionamento e' basato sulla lettura del codice e
potrebbe essere sbagliato su un dettaglio (per esempio `containsPath` potrebbe
gia' canonicalizzare piu' in basso nella catena, o `Bun.write` potrebbe
rifiutare di seguire il link). Va detto chiaramente: **questa e' un'ipotesi, non
un difetto confermato.**

## Test da fare, con il controllo positivo

Il test DEVE avere una scrittura di controllo dentro il perimetro. Senza, un
tool che non scrive nulla passa per sicuro, ed e' esattamente l'errore che ha
falsato la prima verifica V11.

1. **controllo positivo**: `write` su `programs/bcny/prova.txt` -> deve
   riuscire, file presente
2. **creazione del symlink**: l'agente crea `programs/bcny/fuori` ->
   `/etc` (dentro il perimetro, quindi autorizzata)
3. **attacco**: `write` su `programs/bcny/fuori/prova.txt`
4. **verifica dall'host**: `/etc/prova.txt` nel container deve essere ASSENTE
5. **distinguere gli esiti**: `deny` del perimetro e' il risultato atteso;
   `EACCES` e' un blocco del sistema, non del perimetro; `ask` e' peggio — e'
   un'operazione consentita che aspetta una decisione

Se `deny` non arriva e il file viene creato, il difetto e' confermato e la
priorita' sale sopra la fuga laterale.

## Criterio di chiusura

- [ ] il controllo positivo scrive dentro il perimetro (test valido)
- [ ] il symlink viene negato dal perimetro, o il path viene canonicalizzato
        prima del confronto
- [ ] nessuna forma di TOCTOU: non basta controllare e poi scrivere, se il
      controllo e la scrittura sono separati nel tempo (`write.ts:27`,
      `edit.ts:45`, `apply_patch.ts:62`)

## Verifica `deleg_5b020b7c` (2026-09-27) — CONFERMATO, con una pecca nel test

Il difetto **e' reale**: il perimetro autorizza percorsi che sembrano dentro
`bcny` ma scrivono in `programs/bcny-test`, che e' un programma diverso.
`external-directory.ts:17` confronta il path lessicale, che resta sotto `bcny`
anche quando un componente e' un symlink.

### Prove (tutte con controllo positivo, verificato dall'host)

| prova | esito CyberStrike | verifica dall'host |
|---|---|---|
| controllo positivo `write` in `bcny` | `edit allow`, scritto | file presente in `bcny` |
| `write` via symlink `bcny/link -> bcny-test` | `edit allow` | **file in `bcny-test`**, fuori perimetro |
| `edit` via symlink | `edit allow` | **file in `bcny-test`**, fuori perimetro |
| `apply_patch` via symlink | `edit allow` | **file in `bcny-test`**, fuori perimetro |

Tutti e tre i tool che scrivono sono affetti, non solo `write`.

### I due limiti della prova, da non dimenticare

1. **Il symlink era una fixture preparata dal test**, non creato dall'agente. Con
   `BB_ROOT` montata `rw` l'agente *potrebbe* crearselo da solo, e allora la
   fuga diventa utilizzabile senza preparazione. Non e' dimostrato: e' il punto
   che V13 (`verify-v13-symlink.sh`) deve stabilire.
2. **Non era una sessione live `bb hunt`**: le implementazioni reali dei tool
   sono state esercitate con il ruleset reale, ma non il percorso completo
   `prompt -> tool -> gate -> filesystem` di una sessione pilotata dal modello.

Su `/etc` l'esito e' stato `edit allow` seguito da `EACCES`: il perimetro ha
autorizzato, e ha bloccato il sistema operativo. Questo **conferma che il
perimetro non copre la destinazione reale**. Il tentativo di creare il symlink
verso `/etc` con bash e' stato negato (`external_directory deny /etc/*`).

## Percorsi dinamici: `ask` NON e' una fuga (2026-09-27)

Le tre forme sono risultate `ask`, non `deny`:
`$HOME/prova`, `$(echo /etc/prova)`, `bash -c '...'`. Nessuna ha scritto, e
questo e' corretto per costruzione: `PermissionNext.ask` (`permission/next.ts:305-320`)
restituisce una `Promise` che si risolve **solo** con una risposta umana. Senza
risposta la Promise resta pendente e il tool non parte. `bb hunt` non ha un
auto-approve (`cli/cmd/bb.ts` non chiama `PermissionNext.reply`).

Quindi in un flusso non presidiato un `ask` **blocca**, e blocca dal lato
sicuro. Il rischio residuo non e' la fuga immediata, e' la promessa pendente:
una sessione autonoma che chiede conferma e non la riceve resta ferma. Va
deciso se in modalita' autonoma `bash`/`bash_unresolved` debbano essere `deny`.

## Criterio di chiusura

- [x] il controllo positivo scrive dentro il perimetro (test valido)
- [x] il symlink viene autorizzato dal perimetro: difetto **confermato**
- [ ] V13: l'agente riesce a creare da solo il symlink in una sessione reale?
      (decide se la fuga e' utilizzabile senza preparazione)
- [ ] il path canonico viene controllato, non quello lessicale
- [ ] nessuna forma di TOCTOU fra controllo e scrittura (`write.ts:27`,
      `edit.ts:45`, `apply_patch.ts:62`)

## Le DUE porte (2026-09-27, lettura del codice) — correggere una sola non basta

Il subagent ha indicato `external-directory.ts:17` come il punto da cambiare.
Leggendo il percorso completo ne emergono **due controlli indipendenti**, e
bypassarne uno fa passare comunque l'attacco.

### Porta 1 — `external_directory` (lessicale)

`Instance.containsPath` (`project/instance.ts:59-64`) chiama
`Filesystem.contains` (`util/filesystem.ts:35-37`):

```ts
export function contains(parent: string, child: string) {
  return !relative(parent, child).startsWith("..")   // puramente lessicale
}
```

`relative()` opera su stringhe: `bcny/link/pasd` con `link -> bcny-test` resta
 sotto `bcny`, quindi contiene = true, e il controllo passa.

### Porta 2 — la regola `allow("edit", "bcny/*")` (anch'essa lessicale)

Il perimetro concede il path **relativo al worktree**:
`permission/project.ts:471-483` costruisce `allow("edit", rel + "/*")`, e i tool
chiedono `edit` con `path.relative(Instance.worktree, filepath)`
(`write.ts:37`, `edit.ts:61,93`, `apply_patch.ts:176`).

Anche questo confronto e' lessicale, per lo stesso motivo. Quindi:
- bypassando la porta 1, si arriva alla porta 2, che chiede `edit` con il
  pattern `programs/bcny/link/pasd` e ottiene `allow` dalla regola `bcny/*`;
- **la regola che concede il perimetro e' essa stessa traversata dal symlink**.

Questo spiega perche' il subagent ha visto `edit allow` su un path che scriveva
in `bcny-test`: non e' che il controllo mancasse, e' che **entrambi i controlli
concordavano** con un path che non esisteva.

### Il TOCTOU, e perche' il fix non puo' essere solo "canonicalizza"

`write.ts` controlla a `:27` e scrive a `:45`: 18 righe, con un `await ctx.ask`
in mezzo. Se si canonicalizza solo il path controllato, un symlink creato in
quella finestra fa scrivere fuori.

Correggere richiede **entrambi**:
1. confrontare il path **canonico** (realpath del parent, perche' il file
   finale spesso non esiste ancora);
2. **usare il path canonico anche per la scrittura**, non solo per il confronto,
   cosiche' la finestra non contiene piu' nulla di decidibile.

Il secondo punto e' quello che chiude davvero. Il primo da solo e' un miglioramento
cosmetico che lascia la corsa aperta.

### Nota su `apply_patch`

`apply_patch.ts:61` usa `path.resolve`, che normalizza i `..` ma **non segue i
symlink**: risolve la sintassi, non il filesystem. Stesso difetto degli altri due.

## RISOLTO (2026-09-27) — path canonico per controllo E scrittura

**Decisione di progetto:** per il flusso bug bounty nessun symlink e' un caso
legittimo. Si nega la scrittura attraverso un link invece di distinguerlo: piu'
semplice da mantenere e piu' difficile da sbagliare. Se un programma avesse
bisogno di symlink interni si puo' cambiare in cinque minuti.

### Cosa e' cambiato

`external-directory.ts`:

- nuovo `resolveWritePath(target)` -> `{ requested, canonical, viaSymlink }`.
  Risolve il **parent** col `realpath` (il file spesso non esiste ancora), e
  ricompone il path canonico;
- `assertExternalDirectory` confronta `Instance.containsPath(canonical)` invece
  del path lessicale, e **restituisce** il path canonico.

Perche' restituire il path e non solo controllarlo: `write`, `edit` e
`apply_patch` scrivono su quello che ricevono, quindi controllo e scrittura
riguardano lo stesso inode e la finestra del TOCTOU non contiene piu' nulla di
decidibile. Una copia della canonicalizzazione per tool sarebbe una porta che
qualcuno puo' dimenticare di aggiornare — e nel primo giro del fix
`apply_patch` aveva infatti la copia propria.

### Verifica: `test/permission/symlink-perimeter-escape.test.ts`

4 test, che esercitano i tool **veri** (non una ricostruzione):

- **controllo positivo**: scrivere dentro il perimetro funziona e il file
  esiste davvero. Senza questo, "non e' successo nulla" non distingue perimetro
  da tool rotto;
- `write`, `edit`, `apply_patch`: il canary NON deve finire in `bcny-test`.

**Controprova (la parte che conta).** Con i quattro file riportati a HEAD i tre
test di attacco falliscono e il canary `"RUBATO"` finisce davvero in
`bcny-test`; con il fix i 4 passano. Il test puo' quindi fallire: non e' un
verde che dimostra niente.

Una nota metodologica: la prima versione del test lasciava passare ogni `ask` e
catturava l'errore, quindi restava verde **anche con la difesa spenta** — un
falso verde costruito da me. Il test e' stato riscritto per passare dal gate
reale (`PermissionNext.ask` col ruleset del perimetro) e rendere visibile
l'esito. `edit` pretende inoltre che il file sia stato letto
(`FileTime.assert`): senza registrare la lettura il test misurava quel
vincolo e la denial arrivava per il motivo sbagliato.

### Fatti misurati

```
worktree:            undefined            (nessun repo git: e' il caso reale)
Instance.directory:  .../programs/bcny
requested:           .../bcny/link/rubato.txt
canonical:           .../bcny-test/rubato.txt
viaSymlink:          true
containsPath(requested): true      <- la porta aperta
containsPath(canonical): false     <- il path reale
```

### Test

- `test/permission/symlink-perimeter-escape.test.ts`: 4/4
- `test/tool test/permission test/session`: 939 pass, 0 fail
- `bun turbo typecheck`: 11/11

### Cosa resta aperto

Il perimetro e' ora corretto sul piano software. Non risolve la **fuga
laterale**: `/work/bugbounty` e' montato `rw` con tutti i programmi e
`credentials.json`, quindi l'agente di un programma vede comunque gli altri
programmi (vedi `fuga-laterale-fra-programmi.md`, V11 ancora NON PASSA).

## SECONDA VERIFICA AVVERSARIALE (`deleg_0605e823`) — 1 difetto REALE confermato

Il fix iniziale e' stato passato a due subagent indipendenti con mandato
avversariale. Uno ha trovato che il fix era **aggirabile**; l'altro ha
confermato che il test era onesto ma misurava solo la porta 1.

### Difetto reale: parent inesistente sotto un symlink

`resolveWritePath` risolveva solo `dirname(absolute)`. Se un componente
intermedio e' un symlink e la directory finale **non esiste ancora**,
`realpath(parent)` fallisce e il codice ripiegava su `realParent = parent`,
presuppongendo che `mkdir -p` creasse directory reali. **Presupposizione
falsa**: `mkdir -p` segue il symlink.

```ts
project/link -> programs/bcny-test
apply_patch "Add File: project/link/newdir/rubato.txt"
// il canary finiva in bcny-test/newdir/rubato.txt
```

**Corretto**: `resolveDeepest` sale dalla destinazione fino alla prima
directory esistente, la risolve col `realpath` e riappone i tratti mancanti
(inesistenti per definizione, quindi non possono essere symlink). Il limite di
64 iterazioni evita cicli su permalink patologici.

Test che lo copre: `CRITICO 1: parent inesistente SOTTO un symlink`.

### Difetto NON riprodotto: symlink sul file stesso

Il subagent riferiva che `write` con `project/victim.txt -> altro/victim.txt`
sovrascrivesse il file esterno. **Non si riproduce**: il file esterno resta
intatto, e il test passa anche a HEAD (cioe' `write` rifiutava gia' quel caso).
Il test e' rimasto, ma **rinominato in `REGRESSIONE`** e commentato: e' una rete
di sicurezza, non una prova che il fix serva. Segnarlo cosi' e' parte del
lavoro: un verde che non puo' fallire non dimostra niente.

### Difetto NON riprodotto: `apply_patch` move

Il subagent segnalava che `apply_patch.ts:121-129` scarta il path canonico di
`movePath` e conserva quello lessicale. Il codice era vero, ma il perimetro
**blocca** comunque il move: il test passava perche' la fuga non avveniva, non
perche' il path fosse canonico. Il test asseriva per errore che il file
arrivasse fuori; corretto per asserire che **non** arrivi fuori.
`movePath` resta codificato lessicalmente: difetto latente, non sfruttato.

### Limite confermato: la porta 2 non e' misurata

Il test verde dipende dalla **porta 1** (`external_directory`). Bypassando solo
quella in `ctx.ask`, tutti e tre gli attacchi passano: la regola
`allow("edit", "<programma>/*")` non difende da sola. Il fix rende la porta 1
solida, e la porta 2 riceve ormai il path canonico, ma **non e' dimostrato** che
la porta 2 basti da sola. Nota: un tentativo del subagent di rimuovere le
regole `edit` ha fatto andare in timeout il test positivo, quindi non e' una
prova pulita su quel punto.

### Test finali

- `test/permission/symlink-perimeter-escape.test.ts`: **7/7**
- controprova a HEAD: **5 falliscono**, controllo positivo verde, 2 passano
  (il controllo positivo e il test di regressione etichettato come tale)
- `test/tool test/permission test/session`: **942 pass, 0 fail**
- `bun turbo typecheck`: **11/11**

### Ancora aperto

- la **porta 2** non e' dimostrata come sufficiente da sola;
- `apply_patch` `movePath` resta lessicale (non sfruttato);
- **V11 resta NON PASSA**: il perimetro software e' corretto, ma `BB_ROOT` e'
  montata `rw` con tutti i programmi e `credentials.json`.

## TERZO VERIFICA AVVERSARIALE (`deleg_f9dda4ce`) — 1 difetto REALE confermato

Il 2o giro aveva dichiarato chiuso il buco sui parent inesistenti. Un terzo
giro di due subagent indipendenti ne ha trovato un altro, **non ipotizzato ma
riprodotto**: il symlink DANNEGGIATO.

### Difetto reale: symlink che punta a un file esterno inesistente

```ts
project/dangling -> programs/other/created.txt   // created.txt NON esiste
WriteTool({ filePath: "project/dangling", content: "ESCAPED" })
// il canary finiva in programs/other/created.txt
```

`resolveDeepest` saliva di un livello alla volta e, quando `realpath` falliva,
lo trattava come "componente inesistente" e lo conservava nel path. Ma
`realpath` fallisce **identico** sia per un componente semplicemente
inesistente sia per un symlink danneggiato, e i due casi non sono equivalenti:
il secondo verra' seguito da `Bun.write`. Il perimetro quindi autorizzava un
path che la scrittura usava per uscire.

Riprodotto da me eseguendo il test lasciato dal subagent: `outsideExists:true`,
`content:"ESCAPED"`, `asked:["edit"]` — il gate `external_directory` non era
nemmeno scattato.

**Corretto**: quando `realpath` fallisce, `lstat` distingue i due casi. Se il
componente e' un symlink, si legge la destinazione con `readlink` (risolvendo
i path relativi contro la directory del link) e la si risolve al suo posto.
Test che lo copre: `CRITICO 3: symlink DANNEGGIATO non crea il file fuori perimetro`.

### Test: 8/8, controprova a HEAD 6 falliti

| test | a HEAD |
|---|---|
| CONTROLLO POSITIVO | PASS (serve: senza di lui il resto non prova nulla) |
| write / edit / apply_patch (symlink su directory) | FAIL |
| CRITICO 1 (parent inesistente sotto symlink) | FAIL |
| ALTO (apply_patch move) | FAIL |
| CRITICO 3 (symlink danneggiato) | FAIL |
| REGRESSIONE (symlink sul file stesso) | PASS — etichettato, non e' una prova |

### Cosa il 3o giro ha confermato sulla mia suite

- i sei test rossi falliscono per la ragione **giusta**: l'assert decisivo e' la
  denial o il contenuto del file esterno, mai un errore collaterale;
- `edit` registra la lettura sia via symlink sia sul path canonico, quindi
  `FileTime.assert` non maschera il risultato;
- gli `allow` del perimetro di test corrispondono a `buildProjectRuleset` in
  produzione.

### Ancora aperto, dichiarato

- **la porta 2 non e' dimostrata sufficiente da sola**: bypassando solo
  `external_directory` tutti e tre gli attacchi passano. La regola
  `allow("edit", "<programma>/*")` non e' mai stata provata come difesa
  autonoma, e un tentativo di testarla ha fatto andare in timeout il test
  positivo, quindi resta una lacuna reale;
- **`apply_patch` `movePath`** resta codificato lessicalmente: il perimetro
  blocca comunque, quindi difetto latente e non sfruttato;
- **V11 resta NON PASSA**: questo ticket riguarda il perimetro *software*.
  `/work/bugbounty` e' ancora montata `rw` con i programmi degli altri e
  `credentials.json`, quindi la fuga laterale fra programmi resta aperta e
  va risolta con i mount stretti (ticket separato).
