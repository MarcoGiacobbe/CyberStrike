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
