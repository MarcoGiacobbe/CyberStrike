# Ticket: comando `bb hunt` — entry point del progetto di hunting

## Decisioni prese (2026-09-26)

- **NON e' un wrapper su `run`.** Utente: *"no nessun wreapper. Avvio il container
  bash e lancio come se fosse sulla MIA MACCHINA"*. `bb hunt` e' un comando del
  namespace `bb`, come `bb list` e `bb sync` — non un abrogio di `run` con
  contesto accodato da fuori. Nessun canale nascosto (env, file temporanei)
  per far passare contesto o perimetro.
- Progetto orfano (`bb remove` su un programma con hunting in corso): **warning
  esplicito** nel contesto iniziale, non blocco — bloccare impedirebbe di
  chiudere il lavoro.
- Il bootstrap **si ferma al contesto**: il primo `crawl` lo lancia l'agente
  quando il messaggio glielo chiede, non il comando.
- Path: `~/.cyberstrike/bugbounty/programs/<programma>/` (confermato e misurato
  dentro il container: `root()=/work` → `/work/bugbounty/programs/`).

## Perche' "path dedicato" e' la risposta giusta — e non una scelta di gusto

`run.ts:381-387` costruisce le regole **a mano**:

```ts
const rules: PermissionNext.Ruleset = [
  { permission: "question", action: "deny", pattern: "*" },
]
```

e le passa a `sdk.session.create({ title, permission: rules })`. `run` non
chiama `ProjectPerimeter`, quindi **il perimetro non viene applicato da nessun
comando di produzione**: `grep` fuori dai test non trova nessun caller di
`buildProjectRuleset`. È l'**E1** già segnalato nella MAP, e misurato di nuovo
oggi: il perimetro genera 9 regole con `deny external_directory`, ma nessuno le
usa.

Quindi `bb hunt` non e' "un wrapper, ma diverso": e' **il punto in cui il
perimetro entra per la prima volta nel percorso di produzione**. Il codice c'e'
gia', e' testato, e non e' collegato. Un wrapper su `run` dovrebbe duplicare
`run` o passare per canali nascosti — che e' esattamente cio' che l'utente ha
respinto.

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

## Specifica (2026-09-26) — le decisioni chiuse

Utente: TUI interattivo (la CLI originale, MUST) e `--dry-run` sì.

### Perche' non serve un wrapper, e non serve inventare nulla

Il percorso esiste gia' ed e' gia' stato scritto — manca solo il collegamento:

| Pezzo | Stato |
|---|---|
| `ProjectPerimeter.buildProjectRuleset()` (`permission/project.ts:438`) | **scritto e testato**, genera 9 regole, `deny external_directory` presente |
| `Session.createNext({ directory, permission })` (`session/index.ts:267`) | **accetta gia'** `permission: PermissionNext.Ruleset` e lo scrive nella sessione |
| il commento in `permission/project.ts:9` | dice gia': *"Il ruleset prodotto viene passato a `session.createNext({ permission })`"* — il progetto si aspettava esattamente questo |
| `BountyState` (root/directory/read/write/Phase) | scritto e testato |
| `bb.ts` con 11 sottocomandi | scritto, `hunt` mancante |

Il perimetro si perde in **un punto solo**, misurato: il TUI crea la sessione in
`cli/cmd/tui/component/prompt/index.tsx:543` con `session.create({})` — **senza
regole**. E `run.ts:381-387` costruisce `rules` a mano (un solo `deny question`).
Quindi `grep` fuori dai test non trova nessun caller di `buildProjectRuleset`:
è **E1** della MAP, confermato di nuovo oggi.

### Il design

`bb hunt <program>` fa, in quest'ordine:

1. risolve il programma e la sua directory (`BountyState.directory(root, program)`)
2. se la directory non esiste, la crea e avvisa che serve `bb sync <program>`
3. carica lo stato (`BountyState.read`) — fase, target toccati, finding
4. costruisce il **ruleset** con `ProjectPerimeter.buildProjectRuleset(dir, worktree)`
5. crea la sessione con `Session.createNext({ directory: dir, permission: rules })`
6. apre il **TUI** passando `sessionID`, cosi' il TUI NON crea una sessione nuova
   (`prompt/index.tsx:543` lo fa solo quando `sessionID` e' assente)
7. inietta il messaggio iniziale come `--prompt`

Il punto 6 e' quello che rende il perimetro efficace: pre-creando la sessione
con le regole, il TUI la riusa e non ne crea una vuota. Nessun canale nascosto via
env o file temporanei: tutto passa per argomenti e per la sessione persistita.

### `--dry-run`

Stampa il messaggio iniziale, il perimetro (le regole che verrebbero applicate) e
lo stato caricato, poi esce **senza creare sessione e senza interrogare l'LLM**.
È il modo per ispezionare il contesto e per farlo verificare da un subagent.

### Criteri di chiusura

- `bb hunt <program> --dry-run` stampa scope, regole, payout, fase, header
  richiesti — e non crea sessione (verificabile senza LLM)
- `bb hunt <program>` apre il TUI con la sessione **già** creata col perimetro
- la sessione creata ha `permission` non vuota in DB
- il perimetro è effettivo: un tool di scrittura fuori dalla directory del progetto
  viene negato
- rilanciato a metà non duplica nulla e riprende dalla fase salvata


## Implementazione (2026-09-26) — FATTA, in verifica indipendente

Tre file:
- `packages/cyberstrike/src/session/hunt-context.ts` (**nuovo**) — costruisce il
  messaggio iniziale e il riepilogo dello stato. Nessun LLM, nessuna rete: solo
  testo dai dati, cosi' `--dry-run` e' verificabile da solo.
- `packages/cyberstrike/src/cli/cmd/bb.ts` — il comando `hunt <program>` dopo
  `crawl`, con `--agent` e `--dry-run`.
- `infra/bounty-sandbox/run-sandbox.sh` — il mount della root bug bounty.

### Quattro difetti trovati e chiusi durante l'implementazione

1. **Il TUI non e' un sottocomando.** Avevo scritto `["thread", ...]`, ma
   `TuiThreadCommand` ha `command: "$0 [project]"` (`tui/thread.ts:45`): e' il
   comando **default**. Con `"thread"` CyberStrike avrebbe stampato l'help e
   aperto niente.
2. **I config dei programmi non arrivavano nel container.** Stanno in
   `~/.cyberstrike/bugbounty/<handle>.json`, ma il volume montava solo
   `.../bugbounty/programs/`: `bb loadProgram` falliva per **tutti** i programmi
   e ogni `bb hunt` diceva "non sincronizzato", anche per `bcny` che e'
   sincronizzato. Risolto montando la root bug bounty (un mount, al posto
   giusto).
3. **La creazione della directory avveniva prima di sapere se il programma
   esiste.** Un refuso creava una directory vuota che il lancio successivo
   scambiava per un progetto abbandonato. Ora si crea solo se il config esiste.
4. **`orphan` era la condizione sbagliata.** Avevo scritto
   `!unsynced && exists(dir)` — cioe' esattamente il caso normale di un hunting in
   corso, che riceveva l'avviso "programma rimosso". Quella e'
   `unsynced && exists(dir)`: config assente, directory presente. Misurato su
   `bcny`, che è sincronizzato e riceveva l'avviso falso.

### Un difetto di lettura che vale la pena

`getBugBountyManager().getProgramConfig()` restituiva il config **in memoria**,
non quello del programma richiesto: `loadProgram` cerca in `programsDir` (la
directory interna del manager, che segue `CYBERSTRIKE_HOME` ma non il volume
montato) e `getProgramConfig()` restituisce "l'ultimo caricato". Con quello,
`unsynced` non diventava mai vero. Ora il comando **legge il file direttamente**:
il filesystem non mente. (E `Session.get` restituisce l'`Info` direttamente, non
`{ info }` — la mia prima lettura era sbagliata.)

### Il punto in cui il perimetro entra in produzione

`Session.createNext` usa `Instance.project` (`session/index.ts:278`) e va in
errore senza context: serve il wrapper standard `bootstrap(directory, cb)`
(`cli/bootstrap.ts`, stessa forma di `skill.ts`/`pr.ts`). Con quello, misurato:

```
permission in DB: 9 regole
directory in DB:  /work/bugbounty/programs/bcny
```

Reggressioni: typecheck **11/11**, suite **935 pass / 0 fail** (73 file).


## Verifica indipendente (2026-09-26) — 5 difetti reali, tutti chiusi

Il subagent avversariale ha trovato 5 difetti riprodotti. Due gravi.

### 1. PATH TRAVERSAL (grave) — chiuso

`BountyState.directory()` fa `path.join(base, "bugbounty", "programs", program)`
senza validare il nome. Con `../../../tmp` la directory — e quindi il
**perimetro** — usciva da `programs/`:

```
$ bb hunt "../../../tmp" --dry-run
directory progetto: /tmp
  allow  edit  /tmp/*          ← scrittura concessa su /tmp
```

Chiuso verificando che il path **risolto** resti dentro `programs/`, che è più
forte di un elenco di caratteri vietati: copre `..`, separatori, nomi vuoti e
quello che non ho ancora pensato. `bb hunt ""` rientrava nello stesso buco
(`path.join` su stringa vuota restituisce `programs/` stessa, e il perimetro
copriva **tutti** i programmi) — ora anche quello è rifiutato.

### 2. `isSafe` ignorato — chiuso

`ProjectPerimeter.isSafe()` (`project.ts:417`) è una **lista positiva**: un
rischio non previsto è rifiutato per default invece di passare in silenzio.
Non la chiamavo. Ora un `risk` non sicuro fa uscire con codice 1 **prima** di
costruire le regole.

### 3. CRASH `No context found for instance` — chiuso

`Session.createNext` legge `Instance.project` (`session/index.ts:278`) e va in
errore senza `bootstrap(directory, cb)`. Io **avevo applicato** la correzione e
credevo di averlo fatto: la `str.replace` non aveva fatto match e non segnala
nulla. Il probe passava perché usava `bootstrap` scritto a mano, non il comando.
**Due volte** nella stessa sessione, con `pkgDir` — la lezione è che
sostituzioni testuali senza verifica danno un falso "fatto".

### 4. `--dry-run` scriveva su disco — chiuso

Il `mkdir` stava prima del check `dryRun`: il dry-run di un programma nuovo
creava `programs/<prog>/program/`. Un dry-run che scrive non è un dry-run.

### 5. I due avvisi erano contraddittori — chiuso

`unsynced` e `orphan` possono essere entrambi veri (config assente + directory
presente = programma rimosso) e stampavano due avvisi insieme. Poi
`(non ancora creata)` compariva anche quando la directory **esisteva**, perché
guardavo `unsynced` invece del fatto `existed`. Ora gli avvisi sono mutuamente
esclusivi e `existed` è un fatto, non un'interpretazione.

### Un sesto difetto, emerso dopo — il TUI non partiva

```
error: Cannot find module 'react/jsx-dev-runtime'
```

Il TUI è JSX e va lanciato come lo lancia lo script `dev` del package:
`bun run --conditions=browser ./src/index.ts` — con `run` e path **relativo**.
`bun --conditions=browser <path-assoluto>` non basta. Nessun modo di tirare a
indovinare: la risposta era copiare l'invocazione che già funziona.
