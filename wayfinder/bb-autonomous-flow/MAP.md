# Map: Bug Bounty Autonomous Flow

Tracker: local markdown (fallback per skill wayfinder — coerente col vincolo
"solo scritture nella directory di lavoro"). Tickets in `tickets/`.

> ## ⚠️ REGOLE FONDAMENTALI — leggere PRIMA di ogni verifica
> **`REGOLE-FONDAMENTALI.md` in questa cartella.** In sintesi:
> 1. **MAI container su container** — un probe non lancia il proprio `docker run`,
>    riusa il container già avviato (`sandbox_exec`).
> 2. **Al termine di ogni test il container è INTERROTTO** esplicitamente, anche
>    se il test è fallito.
> 3. **Prima di avviare, `free -m`**: sotto 2GB liberi non si parte.
> 4. **Nessun test che non misura niente**: controllo positivo, `rc` usato,
>    marker rimossi, controprova a `HEAD`.

## Allineamento 2026-10-01

**Stato ticket: 17 chiusi, 6 aperti, 9 ne' chiusi ne' aperti.**

Non e' una percentuale e non ha un denominatore utile: i 32 ticket non sono
32 pezzi di lavoro equivalenti, e molti sono raccolte di verifica o domande
aperte, non cose da fare. Il numero conta solo se si sa cosa mette dentro.

| | Cosa significa | N. |
|---|---|---|
| **Chiusi** | Il problema di cui parla il titolo e' risolto e verificato. Non basta che il titolo lo dica | 17 |
| **Aperti** | C'e' lavoro verificabilmente mancante | 6 |
| **Non risolti / sospesi / non riprodotti** | Stato reale, ma non e' "chiuso" | 3 |
| **Raccolte di verifica** | Elenchi di copertura, non difetti | 3 |
| **Ricerche e decisioni senza implementazione** | `- [ ]` spuntati, nessun codice | 3 |

Lavoro di oggi verificato: `47bda46ff` (programma inesistente si ferma),
`62c648580` (senza dati non si parte), piu' le 4 fasi di
`agente-bounty-prompt-iniziale`. Suite 1848 pass, typecheck 11/11.

**2026-10-01, simulazione `bcny`:** il perimetro regge (dry-run: 13 asset, `edit`/
`bash` confinati, config read-only), ma il primo run reale e' uscito **0 senza aver
fatto nulla** — [`falso-successo-permesso-non-concesso`](tickets/falso-successo-permesso-non-concesso.md).
Corretto: un `ask` senza operatore ora esce 1 e nomina il permesso. Nello stesso
punto misurato che `run` **ignora** la chiave `permission` della config (costruisce
`rules` con un solo `question: deny`): le regole del perimetro entrano solo da
`bb hunt`.

**2026-10-02, A2 (perimetro anche in `run`):** `run` ha ora il flag `--perimeter
<dir>`, che riusa le stesse tre API di `bb hunt` (`diagnose`, `isSafe`,
`buildProjectRuleset`) e appende le regole **dopo** `question: deny`. La ragione
e solo che e la stessa forma di `bb hunt`: la mia prima giustificazione
(`findLast` lo richiederebbe) era FALSA, `buildProjectRuleset` non emette regole
per `question` e i due ordini danno lo stesso risultato (verificato dalla
verifica avversariale). Opt-in:
senza flag il default e' invariato. `run-sandbox.sh` lo passa. Misurato in
sandbox sul programma reale `bcny`: il perimetro e reale e precoce — a HEAD il
run chiedeva `external_directory (/dev/*)` alla riga 86 del log, col perimetro il
rifiuto arriva alla riga 8 e su un path fuori perimetro. Test
`run-perimeter.test.ts` 4/4, controprova a HEAD con il test che distingue rosso,
suite CLI 104/104, typecheck 11/11.

**Resta aperto:** la **cwd del sandbox e ancora `/app`**, quindi l-agente cerca i
dati del programma nel posto sbagliato e il perimetro lo blocca invece di
guidarlo. `--dir` da solo NON basta: misurato che spostare la cwd sul mount del
programma fa crashare il provider (`no providers found`, exit 0, 7 s) pur
essendo il path esistente e scrivibile. **Causa NON isolata**: la mia spiegazione
iniziale (la config non viene piu trovata) e falsa, la config e in
`/home/hunter/csconfig` e ci arriva regolarmente. Finche non e risolto il prompt
deve dare il path assoluto `/work/bugbounty/programs/<handle>`. Nota anche: `read` su path esterno e in
`ask`, quindi non esiste un'azione di lettura che il default conceda all'esterno —
un test che confronta "leggio fuori" con e senza perimetro non distingue.

## Destination

Dentro cyberstrike, un comando esplicito — `cyberstrike bb hunt <program>`
(nome deciso dall'utente, resta nel namespace `bb`) — avvia o riprende il
progetto bug bounty per quel programma: (1) verifica se esiste già un progetto,
(2) verifica/crea la cartella di lavoro standard, (3) verifica i dati del
programma (scope, regole, payout) e invita a `bb sync` se mancano o sono
vecchi, (4) apre una sessione con un agente istruito per quel programma,
perimetro di scrittura confinato al progetto e stato di hunting caricato prima
di qualsiasi pianificazione — scrivendo SOLO nella directory di lavoro, con
struttura dati standard (JSON) per progetto, niente scritture libere.

L'ideale resta un messaggio in linguaggio naturale ("voglio huntare bcny") che
porta allo stesso risultato (vedi [intercettazione-programma]); il comando è la
versione deterministica e testabile dello stesso flusso.

## Stato reale (RIVERIFICATO 2026-10-01)

> **Le righe sotto sono state rilette contro il codice, non copiate dal 26/09.**
> Il 2026-09-26 questa sezione diceva `bb hunt` **NON ESISTE** e "persistenza
> ROTTA": entrambe le affermazioni erano gia' superate quel giorno stesso e
> non erano state aggiornate. Le ho verificate una per una.

| Cosa | Stato reale |
|---|---|
| `cyberstrike bb hunt` | **ESISTE e verificato** (dal 2026-09-26, `hunt-comando-entry-point.md`). Il comando e' nel namespace `bb`, non un wrapper |
| Programma inesistente | **SI FERMA** (2026-10-01, `47bda46ff`): exit 1 in 4s, nessun TUI. Prima: 200+s e ~800 MB appesi |
| Programma mai sincronizzato + rete assente | **SI FERMA** (2026-10-01, `62c648580`): il fallback sarebbe vuoto, quindi non si parte. Prima: partiva con zero target |
| Rete assente con dati in locale | **PARTE** col fallback dichiarato — comportamento approvato, verificato di nuovo il 2026-10-01 |
| Sync automatico | **FATTO** (2026-10-01, `be4f5b074`): scatta sopra le 24h, `--force` lo forza, l'eta' dei dati finisce nel prompt dell'agente prima dello scope |
| Cartella del programma | **E' il progetto** (2026-10-01, `801d7d906`): passata al TUI con `--project`, non piu' il cwd |
| Istruzioni nella cartella | **FATTE** (2026-10-01, `60ca9a302`): `AGENTS.md` + `scope.md`, che separano i siti web dai prodotti desktop — per `bcny` 5 URL e 8 prodotti, uno dei quali da $20.000 |
| Perimetro in produzione | **CABLATO** sulla via `bb hunt` (`buildProjectRuleset` in `cli/cmd/bb.ts`) |
| Fuga laterale fra programmi | **CHIUSA** — verificata nel codice il 2026-10-01: `run-sandbox.sh:224-227` monta solo `programs/<programma>` rw, i config `:ro`, `credentials.json` non e' montato. `/app:ro` |
| Persistenza dati | **RISOLTA** (`difetto-persistenza-stato.md`, 4/4): volumi nominati |
| Confine kernel | **REGGE** — `escape-test.sh` 6/6 negati, `CapEff=0` |
| `bb --help` | **NON tace piu'** in locale italiano (`4a43b0231`): mancava `.locale("en")` |
| TUI dentro il container | Si apre e disegna — PTY 140x40 |
| Schermo vuoto | **Difetto diverso**: non e' il TUI vuoto all'avvio (ritirato, era falso) ma quello **dopo l'invio del messaggio`. SOSPESO per decisione dell'utente |

### Difetti del container (lista del 26/09 — SUPERATA)

I sette difetti qui elencati erano misurati il 2026-09-26. **Cinque sono
chiusi**: il `node_modules` dell'host (ora un volume con `bun install` dentro),
`/app` in `rw` (ora `:ro`), `/work` non scrivibile (volumi nominati), `run-sandbox.sh`
che non accettava comandi, `/work/sorgenti` come alias della stessa directory.
**La lista e' stata lasciata com'era e va letta come storico, non come stato
corrente** — le verifiche del 2026-10-01 sono nella tabella sopra.

Restano aperti, ma su ticket separati e non su questo elenco: contenimento
kernel completo (`sandbox-docker-contenitore.md`) e il difetto di schermo
vuoto post-invio (`tui-schermo-vuoto-post-invio.md`, sospeso).

## Notes

- Repo: fork CyberStrike, branch `feat/bug-bounty-enhancement`
- Primitive esistenti: comandi `bb` (CLI), launcher/tool hackbrowser, bbmail,
  accounts autonomi, identity injection, prompt Bug Bounty
- Agenti già pronti da riusare: `web-application` (+ `cloud-security`,
  `internal-network`, `mobile-application`) con toolset completo e skill WSTG;
  tool di reportistica: `generate-report`, `triage-vulnerability`, `vrt-check`,
  `scope-check`
- Vincolo HARD (utente): agente senza potere di SCRITTURA fuori dalla directory
  di lavoro; lettura libera ovunque (read è già allow); il vincolo vale anche
  per bash
- Vincolo HARD (utente): informazioni gestite a livello DB/JSON per progetto
- Vincolo HARD (utente): il vincolo di scrittura va imposto MECCANICAMENTE, non
  con istruzioni nel prompt — le regole nel prompt sono rinforzo, non garanzia
- LLM orchestratore: OpenRouter attualmente senza crediti (402) — serve per E2E

## Decisions so far

- **Verifica E2E capacità attuali** (2026-09-24, senza ticket — il link che c'era puntava a un ticket di verifica E2E, che **non è mai esistito**: link rotto rimosso il 2026-09-26): TUI linguaggio naturale esiste; il flow autonomo progetto NON esiste — primitive sì, orchestrazione no. **Verdetto del 24/09**: "`bb hunt` non è implementato". **SUPERATO** il 26/09 (`hunt-comando-entry-point.md`): il comando esiste e gira.
- [Research: scopes senza auth](tickets/research-scopes-senza-auth.md): API H1 richiede auth SEMPRE (401 su tutti gli endpoint senza token) — sync via API = token obbligatorio; fallback public = scrape pagina + warning
- [Struttura directory progetto](tickets/struttura-directory-progetto.md): OPZIONE 1A, **SUPERATA dall'impianto (2026-09-26)**: la root reale e' `~/.cyberstrike/bugbounty/` (base overridabile con `$CYBERSTRIKE_HOME`), e i progetti vivono sotto `~/.cyberstrike/bugbounty/programs/<programma>/` (misurato: esiste solo `bcny-test/crawls/`; `~/bugbounty/` **non esiste**). I file di programma restano in `~/.cyberstrike/bugbounty/` (`<prog>.json`, `<prog>.policy.md`, `<prog>.accounts.json`, `credentials.json` 600, `cyberstrike.json`). Dentro il container (forma **CORRETTA al 2026-10-01**): solo `programs/<programma>/` in rw,
i config di programma in `:ro`, `credentials.json` non montato, `/app:ro`
(`run-sandbox.sh:224-227`, `:451`). La forma precedente — `/work/programmi/` rw con
tutti i programmi visibili — e' stata ristretta per chiudere la fuga laterale. Scritture solo via comandi bb
- [Intercettazione programma](tickets/intercettazione-programma.md): OPZIONE A — LLM riconosce intenzione, conferma HITL su programma nuovo, esecuzione solo via comandi bb
- [Sandbox scritture](tickets/sandbox-scritture.md): OPZIONE A — nel flow bb l'LLM non ha strumenti di scrittura libera; tutto via comandi bb; lettura completa ok
- [Credenziali H1 sync](tickets/credenziali-h1-sync.md): RISOLTO (2026-09-24) — l'identifier dell'API è lo username H1, non il valore del token (`markjacob9:<token>` → HTTP 200). `bb connect` ridotto a 2 passi, auto-retry con username, token mascherato in `whoami`. Commit `7fa7f8fee`
- [Identity da policy](tickets/identity-da-policy.md): APERTO (2026-09-24) — `resolveIdentity()` pronta e verificata ma `cfg.identity` non viene mai popolato: `bb sync` lo conserva soltanto. Serve derivare header/UA dalle direttive del programma. Caso di test utile: programma HackerOne `security` (chiede header custom), NON bcny (non lo chiede)
- [Help comandi bb](tickets/help-comandi-bb.md): **CHIUSO (2026-09-28)** — il difetto descritto qui era STALE: `bb --help` elencava gia' tutte e 12 le azioni. Il difetto **vero**, misurato col CLI reale: `cyberstrike bb` da solo usciva con **rc=1 e ZERO byte** (e cosi `mcp`, e tutti i 12 gruppi con `demandCommand()`), perche' con `LANG=it_IT` yargs carica `locales/it.json` che **non contiene** "Not enough non-option arguments" e la chiave assente produce `undefined` invece di un fallback. Con `LANG=C` gli stessi comandi stampano l'help (1965 byte): il difetto colpiva proprio l'utente italiano. Fix: `.locale("en")` in `src/index.ts` (punto unico, risolve tutti i gruppi) + `.demandCommand(1)` e handler esplicito in `bb.ts`. Controprova a HEAD: 0 byte / 1 pass 2 fail; col fix 3 pass 0 fail. Difetti adiacenti ANCORA APERTI e non coperti da questo ticket: paginazione assente (limite 100 scope), wildcard non convertiti in pattern, policy troncata a 500 char nel JSON
- [Fuga laterale fra programmi](tickets/fuga-laterale-fra-programmi.md): **RISOLTO — riconfermato sul codice 2026-10-01** — il launcher accetta `--program <nome>` e monta SOLO `programs/<nome>` (rw) + `<nome>.json` / `.accounts.json` / `.policy.md` (ro). **La root `bugbounty/` non e' piu' montata**: `credentials.json` e i config degli altri programmi non esistono dentro il container — non negati, assenti, quindi nemmeno leggibili. Il nome e' validato con `[!a-z0-9_-]*` **prima** di costruire path e prima di toccare docker: senza, `--program ../../etc` avrebbe trasformato il mount stretto in un mount della root (misurato: i 3 tentativi escono con exit 2). **Test** `verify-v14-lateral.sh` PASS con controprova pulita: riportando il mount a largo il test va rosso e **la fuga arriva davvero sull'host**, controllo positivo verde in entrambi i casi. `verify-v15-bb-hunt.sh` PASS (non regressione di `bb hunt`, rosso senza il ramo `bb`). **Difetto mio trovato in verifica:** il launcher non aveva un ramo `bb`, quindi `run "bb hunt ..."` finiva in `... src/index.ts run "$CS_CMD"` = una sessione LLM che leggeva il sorgente invece di eseguire il comando; `--dry-run` non stampava mai `=== MESSAGGIO INIZIALE ===` e sembrava un fallimento del perimetro. **Resta aperto:** `bb list` mostra solo il montato (dato non disponibile nel confine, non un bug); `/app` resta `rw` (preesistente).
- [Symlink non canonicalizzato](tickets/symlink-perimetro-non-canonicalizzato.md): **RISOLTO al 3o giro** — la sezione in fondo cita ancora «V11 resta NON PASSA»: e' stale, la fuga laterale e' chiusa (`run-sandbox.sh:224`) (`deleg_0605e823`, poi `deleg_f9dda4ce`, 2026-09-27) — **tre difetti reali trovati da subagent avversariali, non ipotizzati**; i primi due fix erano incompleti. Difetto di fondo: `write`/`edit`/`apply_patch` scrivevano in `programs/bcny-test` passando da un symlink dentro `bcny`, perche' i controlli confrontavano il path *lessicale*. Erano **due porte indipendenti** (`external_directory` e la regola `allow("edit", "<programma>/*")` che concede il perimetro) piu' il TOCTOU fra controllo e scrittura. **1o buco**: si risolveva solo `dirname`; con un componente intermedio symlink e directory finale inesistente, `realpath` falliva e il fallback presupponeva che `mkdir -p` creasse directory reali — presupposizione **falsa** (`mkdir -p` segue il symlink); canary in `bcny-test/newdir/rubato.txt`. **2o buco**: il **symlink danneggiato** (punta a un file esterno inesistente) — `realpath` fallisce identico sia su un componente inesistente sia su un link danneggiato, ma solo il secondo verra' seguito da `Bun.write`; canary in `other/created.txt` con contenuto `ESCAPED`, e `external_directory` non scattava affatto. Correzione: `resolveDeepest` sale fino alla prima directory esistente, la risolve col `realpath`, riappone i tratti mancanti e sui symlink usa `lstat`+`readlink` per seguire la destinazione. `assertExternalDirectory` confronta `containsPath(canonical)` e **restituisce** `canonical`: i tre tool controllano e scrivono sullo stesso path, quindi la finestra TOCTOU non contiene piu' nulla di decidibile. Test `symlink-perimeter-escape.test.ts` **8/8**, controprova a HEAD **6 falliti** su 8, controllo positivo verde. **Difetti segnalati e NON riprodotti** (etichettati `REGRESSIONE`, non venduti come fix): symlink sul file stesso; `apply_patch` move. **Lacune dichiarate**: la **porta 2 non e' dimostrata sufficiente da sola** (bypassando solo `external_directory` i tre attacchi passano); `apply_patch movePath` resta lessicale (latente, non sfruttato). **La fuga laterale ora e' chiusa** dai mount stretti (vedi ticket dedicato): il perimetro software e' la difesa in profondita, non l'unica.
- [Path dinamici e ask vs deny](tickets/path-dinamici-bask-chiedono-conferma.md): **chiuso come NON fuga, APERTO come ostacolo (2026-09-27)** — resta nell'elenco degli aperti. `ask` non e' una falla: `PermissionNext.ask` (`permission/next.ts:305-320`) restituisce una Promise che si risolve solo con risposta umana, e `bb hunt` non ha auto-approve. **V13 pero' ha scoperto altro:** in modalita' `run` `run.ts:536-549` fa **auto-reject di ogni permesso**, e `ProjectPerimeter` mette `bash` e `bash_unresolved` a `ask` (`permission/project.ts:489,492`) — quindi l'agente **non puo' usare bash in nessun caso**, nemmeno dentro il perimetro. Fail-closed corretto, ma il flusso autonomo non funziona in `run`. In TUI l'`ask` appare all'utente e resta pendente: il flusso e' **semipresidiato**, non autonomo. **Da decidere:** allow esplicito per bash dentro il perimetro, auto-approve limitato, o semipresidiato.
- [Sandbox / perimetro di scrittura](tickets/sandbox-scritture-perimetro.md): **PARZIALMENTE chiuso — V17 del 2026-10-01 (2026-09-25, commit `84d3d4a34`) — gate implementato, 5 buchi chiusi dopo verifica avversariale indipendente.** Aggiornato al 2026-10-01 dopo **sette** giri di verifica avversariale indipendente: chiusi symlink/hard-link sui nomi dei documenti, `tmp/` come symlink o a 0777, `programs/<prog>` come symlink, TOCTOU (ancoraggio via `/proc/self/fd/N`), temporaneo orfano, link verso un programma fratello, e **l'intera catena di cammino** (`programs/` stessa symlinkata: il mio test passava la funzione con un argomento diverso da `bb.ts:861`, quindi era verde e non misurava niente). **Due punti restano APERTI per decisione esplicita dell'utente (2026-10-01), non per dimenticanza**: (a) i comandi con destinatario opaco (`python3 -c`, `touch $(...)`, script) passano da `ctx.ask` — «per ora lasciamo così e accetto il rischio»; (b) la corsa che richiede un processo con i permessi dell'utente sulla host, non innescabile dall'agente (`/work/bugbounty/programs` è `root:root`, il programma è un mount point) — «lascia stare». **V17 chiude due punti:** (a) `tmp/` dentro `programs/<programma>/`, creata da `bb-program-docs.ts` e dichiarata in `AGENTS.md` come l'unica zona scrivibile per i file di caccia — serve nessuna regola nuova, e' dentro il perimetro gia' esistente; (b) `run-sandbox.sh` monta `VOL_CFG` in **`ro`** invece di `rw` (riga 476). **Su (b) la misura ridimensiona il rischio:** dentro quel volume c'e' solo `cyberstrike.json` (provider+modello), **nessuna credenziale** — quindi il pericolo reale era alterare il comportamento della sessione successiva, non rubare segreti. L'avvio non si rompe perche' `mkdir -p` su dir gia' esistente non lancia nemmeno in ro (`global/index.ts:30`, misurato), e `bb hunt --dry-run` dà `RC=0` senza EROFS. **Test** `verify-v17-config-readonly.sh`: 4 percorsi di scrittura negati (3 espliciti + 1 opaco), **controllo positivo** nella tmp di programma e in `csdata`, `bb hunt` funzionante, e volume verificato **integro** (non solo privo di residui). **Controprova**: riportato a `rw` il test va rosso con 4 `SCRITTO`/0 `NEGATO`. **Difetti miei trovati dalla verifica avversariale `deleg_cb90184f` e chiusi lo stesso giorno:** (1) `tmp/` come **symlink veniva seguita** (`mkdirSync` esce 0 e non tocca il link): ora `lstat` la rileva, non viene seguita, e i permessi sono forzati a 0700; (2) il test V17 ispezionava un **volume scritto a mano** invece di quello montato — poteva certificare un volume mai toccato: ora il volume e' **usa-e-getta** e passa al launcher via `VOL_CFG`; (3) il **controllo positivo era falsificabile** (contava le righe `SCRITTO:` senza verificarne la provenienza): ora pretende i due percorsi esatti, per nome; (4) il test di non-regressione accettava **qualsiasi rc** (`ok` con `rc=139` o con output vuoto): ora richiede `rc=0` + output del dry-run; (5) il test lasciava `PROVA_POS` dentro `programs/<prog>/tmp/` sull'host: ora il cleanup lo rimuove. Ognuno ha la sua controprova. Nessun bypass del `:ro` trovato (provati `/proc/self/root`, hard link, symlink, bind mount a runtime, fd gia' aperti, rename della directory): tutti respinti. **`--dry-run`, rettifica di una mia affermazione:** lo stato NON viene scritto in dry-run (`bb.ts:838`, difetto chiuso), ma `AGENTS.md`/`scope.md`/`tmp/` **si'**, ed e' **intenzionale** (`bb.ts:851-854`): senza quel `mkdir` il dry-run falliva con ENOENT e non mostrava niente proprio nel comando che serve a ispezionare. Non e' una regressione (controprovato a HEAD) ne' una contraddizione: e' una scelta di prodotto, col prezzo che `--dry-run` non e' privo di effetti sul disco. **Chiusura parziale dichiarata:** le scritture *esplicite* fuori sono **gia' negate** da `external_directory` senza chiedere conferma (`rm -rf /tmp/x`, `echo > /etc/x`, `sed -i`, `curl -o`) — la premessa «fuori chiede conferma» **era falsa**. Resta aperto il caso **opaco**: `python3 -c "open('/tmp/x','w')"`, `touch $(echo /tmp/x)`, `bash -c '...'`, gli script → `ctx.ask` (`tool/bash.ts:296-308`), e un «si» umano sposta il confine. Negarli alla cieca porta dietro `python3`/`node`/`bun`/`perl`/`ruby`/`php`/`bash`/`sh`/`docker`: **serve decisione dell'utente**, non applicata. **Symlink e TOCTOU: CHIUSI in questo ticket** (2a-4a verifica avversariale, `deleg_6dc3ac19` + `deleg_b41be483`). RIPRODOTTI: (a) `AGENTS.md`/`scope.md` presi come symlink **o hard link** portavano la scrittura fuori — 979/757 byte fuori con `bb hunt --dry-run`; (b) TOCTOU sul percorso del programma: fra il controllo e la scrittura il percorso viene riaperto per nome, quindi chi sostituisce `programs/<prog>` con un link fa uscire la scrittura (harness concorrente del subagent, e caso NON concorrente con `programs/` stessa symlink). **Difesa, cambio di forma e non l'ennesimo controllo:** `withAnchoredDir` apre la directory una volta e scrive ATTRAVERSO `/proc/self/fd/N` (legato all'inode, non al nome) — RENAME del nome: resta dentro; DELETE+symlink: fallisce `ENOENT`, fail-closed; piattaforme senza `/proc`: fallback testuale documentato. In piu' `programs/` symlink rifiutata, `tmp/` symlink rifiutata e creata a 0700, `.tmp` rimosso per nome vero (niente orfani). **Controprova:** senza ancoraggio e guardia-radice il test va **9 rosso / 13 verde**; con esse 22/22. `~` non espanso resta invece APERTO (non toccato). **Danno provocato da un mio probe in questo ticket:** un `rm -rf` lanciato nel sandbox ha cancellato `AGENTS.md`, `scope.md` e `tmp/` del programma reale `bcny` prima di fallire sulla directory (rm cancella i file e fallisce solo sul mount point). Rigenerati dal config, intatto: 976 e 757 byte, tmp 0700. Regola registrata nella skill di disciplina: nel sandbox ogni prova distruttiva va fatta su una COPIA. **V11 resta parziale:** `/home/hunter` resta scrivibile (layer effimero) e `/app` ora e' `ro` (V16). **V8 aggiunse che `buildProjectRuleset`/`diagnose` non avevano caller di produzione: SUPERATO il 2026-09-26, `bb hunt` li chiama e i 9 vincoli sono sul DB. **V11 aggiornato 2026-09-27: la fuga laterale fra programmi e' chiusa e verificata** (`verify-v14-lateral.sh`, controprova pulita). Resta V11 **parziale**: `/home/hunter` e' ancora scrivibile nel container, e `/app` e' montato `rw`. Sono due ticket separati. **(6) il link a un PROGRAMMA FRATELLO** (`deleg_3b5e0b49`): il controllo confrontava solo il prefisso, quindi `programs/bcny -> programs/other` passava e i documenti di `other` venivano SOVRASCRITTI con i dati di `bcny` — non una fuga dal progetto, ma una violazione del perimetro del PROGRAMMA: ora la directory deve essere la figlia diretta di chi contiene il suo nome. **7 buchi chiusi in 5 giri di verifica avversariale indipendente.**
- [Contenimento a livello kernel](tickets/sandbox-docker-contenitore.md): **CHIUSO — corretto il 2026-10-01**. Era segnato "APERTO, non risolto" perche' mancava una sessione reale con risposta resa e tool eseguito: **V12 la chiude, cinque criteri su cinque** (sessione, messaggio, risposta a schermo, tool, perimetro). Il confine e' nel kernel: `escape-test.sh` 6/6 negati, `CapEff=0`. Resta **solo** il cablaggio nel fork, dichiarato FASE 3 nel ticket e mai preso: non e' un difetto, e' lavoro che nessuno ha chiesto.

- [Difetto: il container perde i dati a ogni avvio](tickets/difetto-persistenza-stato.md): **RISOLTO (2026-09-26) — correzione minima, 4/4**. Prima avevo rifatto l'ambiente del container; l'utente ha corretto: *"Solo cyberstrike è dentro docker. Tutto il resto uguale a prima!"*. Ripristinata la versione di prima e corretti i difetti uno alla volta, volumi e `CYBERSTRIKE_HOME` invariati. Il fix che chiude il difetto 2 e' **un path**: `bounty-state.root()` cerca `<root>/bugbounty/programs/` (`bounty-state.ts:110-114`) e il mount era su `/work/programmi` — programmi invisibili e, perche' gate e perimetro si ancorano alla stessa base, **perimetro spento in silenzio**, senza errore. Ora il mount e' su `/work/bugbounty/programs`. Misurato: `root()=/work`, `programsDir=/work/bugbounty/programs`, perimetro genera 9 regole con `deny external_directory`, `run "rispondi esattamente: MINIMO OK"` → `MINIMO OK`, e i file in `/home/hunter` e nel mount sopravvivono al riavvio (il terzo marker, in `/work` stesso, e' `Permission denied`: `/work` e' root-owned nel layer e l'unica dir scrivibile e' il mount, dove il codice scrive). Verifica indipendente su questa versione: in corso (il primo giro aveva verificato la versione superata, i suoi 4 difetti extra sono stati riprovati uno per uno — 2 falsi, `shell -c` rotto **corretto**). **Secondo giro, sul launcher giusto: 7/7 criteri passati** (percorsi, 5 modi d'invocazione, persistenza, provider, area pulita). L'unico difetto segnalato — `run-sandbox.sh echociao` risponde l'LLM invece di eseguire — non e' un bug ma il comportamento voluto (argomento non riconosciuto = messaggio all'agente), ora dichiarato in testata. Issue **#15**.
- [Difetto: schermo vuoto DOPO l'invio del messaggio](tickets/defetto-tui-messaggio-vuoto.md): **SOSPESO (2026-09-28) per decisione utente** — *"non mi usciva piu stamattina, da ignorare"*. Era dichiarato BLOCCANTE il 26/09, ma non e' il blocco attivo. Il passaggio non misurato (invio -> sessione -> risposta -> render) resta l'unica cosa da guardare se ricompare, e per misurarlo il browser nel container era gia' pronto: crash chiuso in `597d46431`
- ~~[Difetto: TUI vuoto nel container](tickets/defetto-tui-container-vuoto.md)~~: **RITIRATO** — le sue tre conclusioni (non parte / non disegna / dimensioni zero) sono state falsate dalla misura con PTY reale. Il ticket resta come lezione metodologica, non come difetto risolto. | — | — |

- [Stato del progetto](tickets/stato-progetto.md): **CHIUSO (2026-09-28) con lavoro futuro**. La review avversariale `deleg_49381b00` ha corretto il verdetto: **E1 era già chiuso** (`bb.ts:702–715` chiama `buildProjectRuleset`; `bb hunt bcny --dry-run` → 9 regole con `deny edit *`) e la MAP era stale. Difetto P1 **riprodotto e chiuso**: la divergenza era solo un avviso — `readChecked()` chiamava `markLoaded()` a `bounty-status.ts:131` **prima** del confronto alla riga 62, quindi uno stato che dichiarava 3 target con zero evidenza sblocca[t]o `todowrite` (`Expected: false / Received: true`). Fix: `blockedFlag` per-sessione in `Instance.state` (`markBlocked/blocked/isBlocked/clearBlocked`), `refresh:false` con divergenze ⇒ blocco, `load()` ⇒ `clearBlocked`, e il gate di `todo.ts` consulta `blocked` **prima** di `loaded`. Test: `bounty-divergence-blocks` (rosso a HEAD) e `bounty-divergence-unblock` (il blocco si riapre, ed è per-sessione). typecheck 11/11, 948 test 0 fail. **Gap (c) di inizializzazione CHIUSO lo stesso giorno**: `bb.ts` passo 3 ora inizializza `state.json` se assente e non `--dry-run`, con discriminante `BountyState.fileExists()` (`instanceof Unreadable` non basta: copre sia "assente" sia "corrotto"). Misurato end-to-end col percorso reale, non col test isolato: `bb hunt probe` → `state.json` mode 600 `phase: idle` `targets: 0` `derivedAt: null`; `--dry-run` non scrive; 2° avvio preserva `phase: reporting` e i target dichiarati; **stato corrotto → `rc=1` e file NON sovrascritto** (B1). Test `bounty-state-initialization` (4 pass). typecheck 11/11, 956 test 0 fail su 5 run consecutivi. **Entrambi chiusi lo stesso giorno**: (b) `divergences()` ora confronta gli ID delle sessioni come INSIEME e anche `lastSeen` (`7b5fa1581`) — a HEAD accettava 40 sessioni inventate e una data del 1999; nel fix un test preesistente (P12) ha rilevato che avevo accoppiato i confronti con `continue` e nascos[o] `firstSeen`, corretto il codice e non il test. (a) la coverage note arbitraria che diventa fatto resta **fuori ticket, non e' priorita'** (deciso dall'utente): misurata col tool reale (nota "NON ho eseguito alcun test" -> `mai-toccato.example`, `COUNT = 1`; con un `request_id` inventato `COUNT = 2`, quindi l'ID non prova niente). Non e' chiudibile finche' non esiste il canale che registra il traffico reale: `Request.add` ha un solo caller ed e' `session.ingest`, route che accetta un messaggio da chi si connette; `session.request`/`session.observations` sono di sola lettura. **Va ricordato a ogni lettura di "Targets touched".** typecheck 11/11, 961 test 0 fail. **Nota**: una prima esecuzione della suite ha mostrato `1 fail` non riproducibile su 9 run; causa probabile 7 file di test che impostano tutti `process.env.CYBERSTRIKE_HOME` a un `mkdtemp` diverso nella stessa esecuzione — preesistente, non introdotto qui, e non ancora isolata. **Chiuso nella stessa sessione**: (c) inizializzazione — `bb hunt` non creava lo stato, `create()`/`setPhase()`/`regenerate()` senza caller di produzione (`83f9ca7d4`); (b) confronto completo dei campi — `sessions` confrontato solo per LUNGHEZZA e `lastSeen` mai confrontato, quindi ID di sessione inventati e date del 1999 passavano come conformi (`7b5fa1581`); in quel fix un test preesistente (P12) ha rilevato che i miei confronti erano accoppiati con `continue` e nascondevano `firstSeen` — corretto il codice, non il test. **Lavoro futuro, non priorità** (utente): la coverage note senza prova tecnica diventa un target toccato — misurato col tool reale (`COUNT = 1` su una nota che dichiarava 'nessun test'), ma non chiudibile finché non esiste il canale che registra il traffico reale: `Request.add` ha un solo caller ed è `session.ingest`, route che accetta un messaggio da chi si connette, e `session.request`/`session.observations` sono di sola lettura. **Va ricordato a ogni lettura di 'Targets touched'.** **Deciso (a)**: l'agente deve chiamare `bounty_status` e resta bloccato finché non lo fa. **Non isolato**: un `1 fail` fantasma è comparso due volte senza riprodursi su 17 run successivi e senza nome del test — non attribuisco una causa.
- [Agente bounty + messaggio iniziale](tickets/agente-bounty-prompt-iniziale.md): **IMPLEMENTATO (2026-09-26)**, la riga APERTO del 24/09 era obsoleta. Il prompt esiste in `packages/hackbrowser/src/prompt/bugbounty.txt` e lo usa `bb hunt`; il manager e' `hackbrowser/src/bugbounty.ts`. **IMPLEMENTATO — 4 fasi, 2026-10-01**. Le fasi 1-3 sono committate (`801d7d906`, `be4f5b074`, `60ca9a302`): la cartella del programma e' il progetto (passata al TUI con `--project`), il sync parte da solo se i dati hanno piu' di 24 ore (`--force` lo forza, il fallback dichiara l'eta' all'agente prima dello scope), e nella cartella ci sono `AGENTS.md` + `scope.md` che separano i siti web dai prodotti desktop — per `bcny` 5 URL e 8 prodotti, uno dei quali da $20.000. **Fase 4 committata in `47bda46ff`**: un programma inesistente si ferma con exit 1 invece di lanciare il TUI da ~800 MB; prima servivano 200+ s e restava appeso. Distinguere 'inesistente' (errore di input, non si risolve) da 'rete assente' (fallback approvato dalla Fase 2) e' stato il punto: l'errore e' tipizzato in `sync.ts` perche' i due testi upstream sono diversi. La verifica avversariale ha poi trovato un secondo caso nella stessa direzione: **programma mai sincronizzato + rete assente** partiva con scope vuoto (stesso principio: il fallback non vale se i dati non ci sono mai stati). Resta aperto: **payout per singolo asset**, che il sync schiaccia in una stringa dentro `rules.custom`
- [Comando `bb hunt`](tickets/hunt-comando-entry-point.md): **IMPLEMENTATO E VERIFICATO (2026-09-26)**. NON e' mai stato scritto (ticket del 24/09 con zero righe di codice) — per questo nel `docker run` dell'utente non c'era. **Non sara' un wrapper**: e' un comando del namespace `bb` come `bb list`/`bb sync` (utente: *"no nessun wreapper. Avvio il container bash e lancio come se fosse sulla MIA MACCHINA"*). Decisioni chiuse: apre il **TUI interattivo** (CLI originale, MUST) e ha **`--dry-run`**. Il perimetro non va inventato: `Session.createNext({ directory, permission })` (`session/index.ts:267`) accetta gia' `permission`, e il commento in `permission/project.ts:9` dice gia' *"Il ruleset prodotto viene passato a `session.createNext({ permission }`"*. **E1 riconfermato oggi**: il perimetro si perde in un punto solo — il TUI crea la sessione in `cli/cmd/tui/component/prompt/index.tsx:543` con `session.create({})`, **senza regole**; e `run.ts:381-387` le costruisce a mano (un solo `deny question`). Per questo `grep` fuori dai test non trova nessun caller di `buildProjectRuleset`. Il trucco: pre-creando la sessione col perimetro e passando il `sessionID` al TUI, questo lo riusa invece di crearne una vuota. Nessun canale nascosto via env o file temporanei. Da decidere in futuro (non ora): se ogni sessione di hunting deve ereditare il perimetro, il posto giusto non e' il comando ma `prompt/index.tsx:543`. **Fatto**: `hunt-context.ts` (nuovo) + il comando in `bb.ts` dietro `crawl`, con `--agent` e `--dry-run`. Misurato: `--dry-run` su `bcny` stampa scope reale (13 target), payout fino a $20.000, regole e **9 regole di perimetro** col path `/work/bugbounty/programs/bcny`; **9 regole in DB** nella sessione riletta — il perimetro entra in produzione per la prima volta. Serve `bootstrap(directory, cb)` (`cli/bootstrap.ts`) perche' `createNext` legge `Instance.project`. Quattro difetti chiusi in corsa: il TUI e' il comando **default** (`tui/thread.ts:45`), non `thread`; i config dei programmi non arrivavano nel container (il volume montava solo `programs/`, non la root bug bounty, quindi ogni programma risultava non sincronizzato); la directory veniva creata prima di sapere se il programma esisteva; e `orphan` aveva la condizione invertita (bcny, sincronizzato, riceveva l'avviso "rimosso"). **Nota**: `getProgramConfig()` restituisce il config in memoria, non quello del programma richiesto — il comando ora legge il file. Typecheck 11/11, 935 test, 0 falliti.
**Verifica indipendente: 5 difetti reali trovati e chiusi.** Due gravi. **Path traversal**: `BountyState.directory()` fa `path.join` senza validare il nome, e con `../../../tmp` il **perimetro** usciva da `programs/` con `allow edit /tmp/*`; `bb hunt ""` rientrava nello stesso buco e copriva **tutti** i programmi. Chiuso verificando che il path risolto resti dentro `programs/` (piu' forte di un elenco di caratteri vietati). **`isSafe` ignorato** (`project.ts:417`, lista positiva): ora un `risk` non sicuro esce prima di costruire le regole. Poi: **crash** `No context found for instance` (`createNext` legge `Instance.project`, serve `bootstrap`); **`--dry-run` scriveva** (mkdir prima del check); **avvisi contraddittori** (`unsynced` e `orphan` insieme, e "non ancora creata" con la directory gia' esistente). Un sesto emerso dopo: il **TUI non partava** — `Cannot find module react/jsx-dev-runtime`; va lanciato come lo lancia lo script `dev`, `bun run --conditions=browser ./src/index.ts` con `run` e path **relativo**. Misurato: il TUI disegna (logo, `# New session`, prompt, tab agents/commands).
**Nota operativa**: quel TUI partiva su `google/gemini-3-pro-image-preview`, non sul provider `omni` dell'ambiente sandbox — la scelta del modello nel TUI e' ancora da cablare.

## Dipendenze fra i ticket

Ordine di implementazione suggerito:

```
sandbox-docker-contenitore    ← PREREQUISITO (il confine vero è nel kernel;
                               │                 il perimetro in JS è il secondo livello)
sandbox-scritture-perimetro   ← secondo livello (resta: serve senza Docker)
        ↓
stato-progetto                ← cosa legge il comando + blocco todowrite
        ↓
agente-bounty-prompt-iniziale ← agente + messaggio (dipende dai dati dello stato)
        ↓
hunt-comando-entry-point      ← unisce tutto, ed è l'entry point della MAP
```

Ticket indipendenti (nessuna dipendenza, si possono fare in qualsiasi momento):
`identity-da-policy`, `help-comandi-bb`, e i difetti annotati in
`help-comandi-bb` (paginazione GraphQL a 100, wildcard non convertiti).

## Verifica — arretrati (NON verificato)

Regola: **ogni verifica di sostanza passa da un subagent indipendente**, con
mandato avversariale (cercare il difetto, non confermare il caso felice). La
verifica dell'autore non conta come verifica. Un ticket non è "fatto" finché
questo elenco non è vuoto per le sue voci.

| # | Cosa manca | Su cosa | Perché non ora |
|---|---|---|---|
| V1 | E2E con `bb hunt` reale (catena comando → sessione → agente → perimetro) | sandbox-scritture-perimetro, stato-progetto, hunt-comando-entry-point | `bb hunt` non esiste ancora: nessun test attraversa la catena fino in fondo |
| V2 | Attrito reale di `bash` in un hunting vero (quante conferme si ricevono, se il flusso è usabile) | sandbox-scritture-perimetro | si misura usandolo su un target, non testandolo |
| V3 | Modifica `always: ["*"]` in `write.ts`/`edit.ts` — la difesa è a valle (`PermissionNext.ask`), la causa è a monte | sandbox-scritture-perimetro (buco #2) | tocca il comportamento di TUTTI gli agenti, non solo del perimetro: serve decisione |
| V7 | Verifica avversariale stato+gate+`always` — **FATTA (2026-09-25)**: 13 buchi (task-0 B1–B13) + 4 sulla difesa `always` (V8.1–V8.4). I più gravi: B1 lo stato invalido NON blocca sul percorso default (refresh rigenera `idle` cancellando la fase), V8.1 escape via bash con un click "sempre", V8.2 seed `approved` batte il deny. Fix A1–A13 **APPLICATI** (commit `66b606d68`) + B14 (nuovo, GRAVE: `dir === worktree` → pattern `"/*"` → allow su ogni path assoluto). Ticket [verifica-stato-gate-always.md](tickets/verifica-stato-gate-always.md) | stato-progetto, sandbox-scritture-perimetro | — |
| V8 | Verifica avversariale dei FIX (`66b606d68`) — **FATTA (2026-09-25)**: 3 subagent separati, 12 cadute + il fatto che riordina le priorità. Dettagli in [verifica-fix-v8.md](tickets/verifica-fix-v8.md). **E1 (decisivo): `buildProjectRuleset` e `diagnose` NON hanno chiamanti di produzione** — il perimetro è una difesa di libreria, non cablata: impatto pratico nullo finché `bb hunt` non lo istanzia (e se il confine verrà espresso con `ask` invece di `deny`, `isPerimeter()` non lo riconoscerà più e tutti i filtri saltano in silenzio → serve un marcatore esplicito di sessione). Causa comune: confronti per **uguaglianza letterale** dove serve una **proprietà**. Perimetro: P1 `coversEverything` letterale (`?????*`, `*/*`, `/etc/*` battono il deny); P2 permission con jolly (`bash*`/`edit*`/`*` svuotano il confine, raggiungibili da config reale); P3 ogni click "sempre" su bash è un no-op permanente (attrito dichiarato "inutilizzabile in pratica", peggiorato); P4 l'override `{question:'allow'}` viene ucciso (serve allowlist delle permission filtrabili). Percorsi: P5 la guardia B14 copre solo `rel===""`, non la salita (`dir=/tmp` → `../*` → `edit('../../etc/passwd')=allow`); P6 symlink non dereferenziati (`state.json` scritto FUORI); P7 `root()` non canonizzato. Stato: P8 **symlink dangling riapre B1** (`existsSync` invece di `lstat`); P9 `read()` non valida `info.directory===dir` (`mv acme acme-2026` → leggere in A riscrive B e cancella in silenzio la fase dichiarata in B); P10 iniezione di righe false nei campi DICHIARATI (basta il nome della directory); P11 gate armato in anticipo + sbloccato da una sottodirectory; P12 `divergences()` non rileva scomposizioni false/evidenza inesistente. **Chiuso e verificato**: il canale interattivo non si svuota con un click, B6 per path, B8, contratto "il tool MANCA", stato invalido che blocca (tranne P8), sanificazione `hostOf`. **Aperta** — fix da approvare in 6 passi (ordine nel ticket). | stato-progetto, sandbox-scritture-perimetro | fatta con 3 subagent indipendenti |
| V9 | Verifica avversariale dei fix V8 (`9d7afe936` + `260e03516`) — **FATTA (2026-09-26)**: 3 subagent separati, 12 difetti. Ticket [verifica-v9.md](tickets/verifica-v9.md). **4 gravi**: G1 `env` è in `READ_ONLY` → `env touch /tmp/x` scrive fuori senza alcuna richiesta, permanente con un click; G2 `command_substitution` scartata a `bash.ts:168` → `touch $(echo /tmp/x)` non estrae path, 0 prompt al secondo run; G3 il marcatore `boundary` è forgejabile (verificato: `allow` su `/etc/passwd`) ma **non raggiungibile oggi** — nessun canale pubblico scrive `boundary` in `approved` (verificato su tutti e tre); G4 `boundaryDenies` ignora il pattern → un deny stretto uccide allow lecite. **Un falso positivo respinto**: nessun tool chiede `write`/`patch` (grep: solo `edit`), quel test era vacuo. **Zero regressioni** sui progetti reali e il round-trip DB conserva `boundary` — la domanda più critica, risposta sì. D5 (FIFO = hang infinito) è DoS e va chiuso presto. Ordine di chiusura nel ticket; G1–G3 sono gli unici con impatto oggi. | stato-progetto, sandbox-scritture-perimetro | fatta con 3 subagent indipendenti; 4 difetti riconfermati su esecuzione dall'autore |
| V10 | Difetti V9: **G1 G2 D5 D10 CHIUSI** in `61639af2a` (typecheck 11/11, 935 test, controprova a difesa spenta: 6 test falliscono). D5 ha rivelato un difetto che il subagent non aveva visto: estendendo `presence()` con "unreadable", `refresh()` rigenerava la FIFO — il buco di B1 riaperto dalla mia stessa difesa. **Restano da decidere**: G4 (`boundaryDenies` guarda l'area ma non il pattern → filtra troppo o troppo poco; **è la terza volta che correggo quella funzione, in due direzioni opposte** — serve la tua lettura, non la mia quarta) e G3 (marcatore forgejabile ma non raggiungibile oggi). D3 (avviso quando la famiglia è revocata), D1/D4 (attrito). **G4 NON richiede una semantica nuova**: il container lo rende privo di soggetto (dentro, "fuori" non esiste). **E1 CONFERMATO (2026-09-26)**: `buildProjectRuleset` **non ha chiamanti di produzione**. Ricontrollato dopo aver rimosso `packages/cyberstrike/_adv{,2,3,4,-always}.ts` (spazzatura di subagent committata per errore, zero riferimenti): gli unici caller rimasti sono in `permission/project.test.ts`. Il perimetro resta una difesa di libreria, senza effetto su nessun agente reale. | sandbox-scritture-perimetro, stato-progetto | G4 risolto per via d'impianto |
| V11 | **SUPERATO (2026-09-27)** — il buco reale dichiarato (la root `BB_ROOT` montata `rw`, con i config di TUTTI i programmi piu' `credentials.json`) e' **chiuso**: mount stretti per programma, verifica `verify-v14-lateral.sh` con controprova. Risolti anche i due punti residui: `/home/hunter/.ssh` **non esiste** piu' nel container (il bind largo e' sparito, quindi non c'e' piu' la home dell'host) e `credentials.json` non e' montata. `/home/hunter` resta scrivibile ma e' il layer effimero del container (`--rm`): non e' una fuga laterale, sparisce alla morte del container. `/app` e' ora `ro` (`verify-v16-app-readonly.sh`, controprova pulita). **Attenzione:** chiudere V11 NON vuol dire che il perimetro regge — vuol dire che la fuga laterale fra programmi e' chiusa. Restano aperte la porta 2 (`allow("edit", ...)` non dimostrata sufficiente da sola) e `apply_patch movePath` lessicale. | sandbox-scritture-perimetro, sandbox-docker-contenitore, fuga-laterale-fra-programmi | chiuso: mount stretti + /app ro; ~/.ssh assente, credenziali non montate. **2026-09-28: due falsi verdi corretti** (`falsi-verdi-nei-test-sandbox`): V14 ignorava i KO del proprio probe e dichiarava PASS su un mount largo; V16 non controllava `rc` e non aveva il controllo positivo |
| V12 | **CHIUSA (2026-09-26)**: cinque criteri su cinque. La causa era il provider di default `qwen-local-cyber` (non presente in config né in auth.json, quindi senza credenziali), non il TUI. Il flag è `-m/--model provider/model`, non `--provider`. Con `omni/auto/best-coding`: risposta resa a schermo (`V12OK`) e tool eseguito (`→ Read README.md [limit=3]`), perimetro rispettato, 0 residui. **#14 era questo**: l'input non entrava perché il ciclo non partiva. | sandbox-docker-contenitore, hunt-comando-entry-point | chiusa, 5/5 |
| V4 | `Paginazione a 100` in `bb sync` e wildcard non convertiti in pattern | help-comandi-bb | difetti annotati, non ancora ticket autonomi |
| V5 | `security` come caso di test per `resolveIdentity()` (programma che CHIEDE header custom) | identity-da-policy | serve il fetch di un programma reale che richieda header |
| V6 | ~~Contenimento a livello kernel~~ — **CHIUSA (2026-09-26)**: il confine e' nel kernel (escape-test 6/6 negati, CapEff=0). La parte che mancava — il flusso bug bounty end-to-end — e' stata chiusa da V12 con cinque criteri su cinque: sessione reale, messaggio inviato, risposta resa a schermo, tool eseguito, perimetro rispettato. | sandbox-scritture-perimetro, sandbox-docker-contenitore | chiusa |
| SQLite | **NON RIPRODOTTO, chiuso** (2026-09-26): `SQLITE_MISUSE` da `prepare()` con `byteOffset: -1`, una volta sola all'avvio del TUI dentro il container; l'utente ha detto «ora va». **Quattro ipotesi escluse con prove eseguibili**: (1) scrittura concorrente fra processi — `sqlite-race.py`, 3 writer x 4 round, 0 errori; (2) statement/handle dopo close — dà `Statement has finalized`, errore diverso, e `close()` non è mai chiamato in `storage/`; (3) volume/filesystem — i volumi sono ext2/ext3, WAL attivo, 200 upsert, 0 errori; (4) due thread sullo stesso file WAL (`new Worker` in Bun è un thread, non un processo) — `sqlite-thread-race.ts`, 0 errori, con `main.rows=400 / worker.rows=336` che prova la concorrenza reale. TUI vero nel container rieseguito: sessione reale, tool eseguito, 0 residui, **nessun errore**. Chiuso come *non riprodotto*, non come risolto: se ricompare serve catturarlo mentre accade (riga precedente nel TUI + stack + timestamp), perché i test hanno provato forme note di `data`, non la forma reale a runtime. | sqlite-misuse-all-avvio-tui | chiuso, non riprodotto |

## Not yet specified

- Step 4: fasi successive del flusso (hunting guidato, report, scheduling,
  ripresa sessioni) — da definire in dettaglio con l'utente
- Multi-programma: registry dei progetti, switch, convivenza
- Cosa succede agli account pending quando l'utente non approva (TTL? reminder?)
- Promozione automatica di una nota di `notes/` a fatto verificato (vedi
  [stato-progetto], punto 6)
- "Target toccato" per azioni fuori dal crawler (curl/bash): buco nero dello
  stato derivato (vedi [stato-progetto], punto 4)

## Out of scope

- Piattaforme ≠ HackerOne per il fetch automatico (Bugcrowd/Intigriti: dopo)
- UI grafica dedicata oltre al TUI esistente
- Modifica a monte del core cyberstrike non necessaria al flusso

## Disallineamenti trovati (audit 2026-09-26)

Trovati e **corretti** in questa tornata:

- `struttura-directory-progetto` diceva `~/bugbounty/`; la realtà è
  `~/.cyberstrike/bugbounty/programs/<programma>/` (misurato, `~/bugbounty/`
  non esiste). Superata da `$CYBERSTRIKE_HOME` + `programs/`.
- Budget container: dichiarati 2g/256 pid, usati 3g/1024.
- **E1** confermato: nessun caller di produzione dopo la pulizia degli `_adv*`.
- Spazzatura `_adv{,2,3,4,-always}.ts` rimossa dal tracking git.
- `V6` da "risolto" a "parziale": il confine regge, l'uso no.
- **Due righe in opposto** sul difetto TUI: una diceva "APERTO — BLOCCANTE",
  l'altra subito sotto "RITIRATO". Rimossa la prima.
- **Link rotto**: la riga "Verifica E2E capacità attuali" puntava a un ticket
  che non è mai esistito. Tolto il link, la sostanza resta.
- **Riga V6 malformata**: avevo 8 separatori di colonna invece di 4 (una coda
  della versione precedente incollata dentro la nuova). Ripulita.
- **La MAP viveva in due copie** — il file e il corpo dell'issue #2, tenute
  allalineate a mano, arrivate a essere due mappe diverse (175 righe contro
  133, con sezioni diverse). **Risolto alla radice**: il testo sta in un posto
  solo (`MAP.md`, già versionato) e l'issue contiene un puntatore e un indice
  (55 righe). Tre controlli in `.github/workflows/map-issue-sync.yml`, tutti
  provati reggere contro la regressione che impediscono.

Ancora da mettere a posto:

- ~~**`bb hunt` non esiste**~~ — **FATTO il 2026-09-26** (`hunt-comando-entry-point.md`,
  `60ca9a302`). Il sottocomando esiste in `cli/cmd/bb.ts:629`. Era una TODO del
  24/09 rimasta scritta al futuro; lasciata com'era, diceva il contrario del codice.
- **Issue #8** (Orchestrator del flusso, 2026-09-24) non riflette nessuno dei
  fatti del 26/09: da riallineare.
- ~~**7 difetti aperti nel container**: nessuno chiuso~~ — **SUPERATO**: cinque dei
  sette sono chiusi (vedi "Difetti del container" piu' in basso, che e' stato
  riletto). Persistenza e programmi invisibili erano i due bloccanti.
- `Not yet specified` → i due punti già annotati (target toccato, promozione
  note) restano aperti e sono collegati a `stato-progetto`.

## TOCTOU fra gate e scrittura — CHIUSO
Il perimetro autorizzava ma la scrittura finiva in un altro programma: il gate
restituiva una stringa, quel nome veniva riaperto dopo. Corretto aprendo
l'handle prima del gate con `O_NOFOLLOW`, cosi' il kernel rifiuta il symlink.
Test permanente rosso a HEAD, verde col fix. `toctou-gate-scrittura.md`

## Riuso del container nei test — CHIUSO
`run-sandbox.sh` ha `--keep`: riusa il container invece di avviarne uno nuovo.
Misurato, 4 invocazioni sullo stesso programma: 1 container con `--keep`, 4
senza. V14 e V16 lo usano con trap di cleanup. Chiuso anche un falso verde in
V14: il marker di un run precedente falsificava il test successivo.
`riuso-container-test.md`

## Browser muto dentro il container — CHIUSO
Chromium crashava con `rc=133` e `chrome_crashpad_handler: --database is
required`. Non era un problema del browser: `docker run -v VOL:/home/hunter/
.config/cyberstrike` fa creare a DOCKER il padre `/home/hunter/.config` come
root, mentre il container gira come `hunter`, quindi Chromium non poteva
scrivere li'. Isolato per differenza (ogni flag da solo rc=0, XDG da solo
rc=0, volume da solo rc=0, XDG+volume insieme rc=133). `chown` non rimedia:
con `--cap-drop=ALL` dà `Operation not permitted`. Fix: i volumi si montano
alla root delle dir XDG, e `HOME`/`XDG_*` sono espliciti. V17 (nuovo) lancia
il browser vero nel container: verde col fix, rosso a HEAD. V14 e V16 restano
verdi. `browser-crash-dentro-sandbox.md`

## Regole fondamentali
Vedi `REGOLE-FONDAMENTALI.md`, in cima a questo file. Non negoziabili: mai
container su container, stop esplicito alla fine di ogni test, massimo 1-2
sessioni, controllo memoria prima di partire.


## Indice dei ticket — ricostruito 2026-10-01 (32 ticket)

La versione precedente di questa sezione dichiarava "23/32 chiusi" e poi,
nello stesso file, elencava i chiusi come 16. **Non tornava con se stessa**,
e la verifica avversariale indipendente lo ha segnalato: il numero era
inventato, non sbagliato di poco.

**Regola usata per classificare un ticket.** Il titolo non vale niente — cinque
ticket scrivono `CHIUSO` nell'`#` e conservano 200 righe sotto la sezione
"ancora aperto" di quando erano aperti. Il verdetto e' l'ultima sezione
scrivta. E serve un terzo criterio, emerso da questa verifica: **un ticket
finito che lascia una domanda senza risposta non e' chiuso.**Applicarlo e'
stato cio' che ha prodotto la categoria "non risolti / sospesi".

**Chiusi — 17.** Il problema del titolo e' risolto e verificato:
`app-readonly`, `apply-patch-move`, `browser-crash-dentro-sandbox`,
`toctou-gate-scrittura`, `falsi-verdi-nei-test-sandbox`,
`difetto-persistenza-stato`, `riuso-container-test`, `help-comandi-bb`,
`hunt-comando-entry-point`, `defetto-tui-container-vuoto` (risolto *come
ostacolo*: la causa era il flag del provider, non il container),
`sandbox-docker-contenitore` (**V12 5/5**: la sessione reale che mancava c'e'),
`research-scopes-senza-auth`, `intercettazione-programma`,
`sandbox-scritture`, `struttura-directory-progetto`,
`fuga-laterale-fra-programmi` (riconfermata **sul codice** il 2026-10-01,
non solo sul ticket), `stato-progetto` (chiuso con lavoro futuro: la coverage
note resta fuori priorita' **per decisione dell'utente**).

**Aperti con lavoro verificabilmente mancante — 4** (erano 6: il
2026-10-01 ne chiude 2, `credenziali-h1-sync` e `bb-sync-fetch-hackerone`).
`sandbox-scritture-perimetro` (**stato al 2026-10-01**: il perimetro **E' cablato** in produzione — `bb.ts:885` passa 9 regole, `deny("external_directory")` nega i path esterni espliciti senza conferma; resta aperto **per decisione esplicita dell'utente** il fallback dei comandi con destinatario opaco, che passano da `ctx.ask`), `identity-da-policy` (`cfg.identity` non popolato in produzione),
`orchestrator-flusso` (i passi 2-4 non esistono: c'e' il comando, non
l'orchestratore), `tui-schermo-vuoto-post-invio` (**sospeso per decisione
dell'utente**: bloccato a valle della discovery dei tool endpoint).

**Chiusi il 2026-10-01 — 2.** `credenziali-h1-sync` e
`bb-sync-fetch-hackerone`: `bb sync` ora usa due fonti complementari — scope
anonimo invariato byte per byte, e **solo se c'e' un token** la policy via
REST (che non tronca) piu' l'elenco dei 595 programmi visibili. Tre fatti
misurati che cambiano il presupposto del ticket: il token **non puo'**
sostituire l'anonimo (`hackerone.com/graphql` risponde `401` al token API),
lo **scope privato non esiste per un cacciatore** (0 privati su 25
campionati), e la REST e' **paginata** (`bcny` e' in pagina 6 su 6: senza
paginazione la policy arrivava solo per i programmi in pagina 1 — paging
verificato stabile, 3 richieste = 3 impronte identiche).

**Chiusi ma NON risolti — 3.** Stati reali, che non vanno mescolati con
"chiusi" perche' un riaprire costerebbe piu' di un aperto:
- `sqlite-misuse-all-avvio-tui` — **chiuso come NON RIPRODOTTO** dopo quattro
  ipotesi escluse. Non e' risolto: non e' riprodotto.
- `defetto-tui-messaggio-vuoto` — criterio di chiusura scritto, ma **mai
  verificato**; il suo file contiene anche 4 file `_adv*.ts` spazzatura da
  cancellare.
- `symlink-perimetro-non-canonicalizzato` — risolto con i mount stretti, ma il
  file conserva in fondo «ancora aperto» e un richiamo a V11 superato.

**Raccolte di verifica — 3.** `verifica-fix-v8`, `verifica-v9`,
`verifica-stato-gate-always`: elenchi di cio' che i fix coprono e di cio' che
no. Non sono difetti aperti. V9 chiude con la nota che i fix al perimetro
sono difesa di libreria senza caller — **superata**: dal 26/09 il perimetro e'
cablato su `bb hunt`.

**Ricerche, piani e decisioni senza implementazione — 3.** Hanno `- [ ]`
spuntati e nessun codice. Alcuni sono *piani eseguiti* che tengono aperte
domande di design, e vanno letti per quello che dicono, non per il titolo:
- `plano-directory-programmi` — piano eseguito, **2 domande aperte** in fondo
- `agente-bounty-prompt-iniziale` — **4 fasi fatte e verificate**, ma il file
  finisce con 5 decisioni di design non prese
- `path-dinamici-bask-chiedono-conferma` — chiuso come NON fuga, **aperto come
  ostacolo** (le richieste di conferma su path dinamici rendono il flusso
  scomodo)

### Perche' la MAP era disallineata, e cosa l'ha causato

Tre cause diverse, e solo la terza e' un errore mio:

1. **Ticket con stato solo nel titolo.** Cinque ticket scrivono
   `CHIUSO 2026-09-28` nell'`#` e poi, 200 righe sotto, conservano la sezione
   "ancora aperto" di quando erano aperti. L'euristica li legge come aperti.
   Il fix esiste, ma il file non è stato riordinato.
2. **Sezioni di chiusura con titoli che sembrano verdetti.** `## Criterio di
   chiusura` è un *titolo*, non un verdetto: leggendolo come chiuso si
   sbaglia. Così ho sbagliato io al primo tentativo, e ho buttato via una
   classificazione automatica che contava 6 chiusi e 12 aperti — numeri senza
   senso, frutto di quella lettura.
3. **Righe del 26/09 mai aggiornate.** La tabella "Stato reale" diceva
   `bb hunt NON ESISTE` e "persistenza ROTTA" quando entrambe erano gia'
   superate. Riletta e riscritta oggi contro il codice.

**Regola per l'avanti:** l'etichetta in cima a un ticket non vale nulla. Il
verdetto e' l'ultima sezione scritta, e va letto sul codice quando tocca il
comportamento — non copiato nella MAP.
