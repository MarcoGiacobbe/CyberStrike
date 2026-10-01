# Ticket: perimetro di scrittura confinato al progetto (sandbox)

## Stato: PARZIALMENTE CHIUSO — 2026-10-01, dopo sette giri di verifica avversariale

**Chiuso e verificato:** i path esterni *espliciti* sono negati senza conferma
(`deny("external_directory")`, cablato in produzione da `bb.ts:885`); la `tmp/`
del programma esiste ed e' l'unica zona scrivibile dichiarata; la config del
container e' in sola lettura; scritture via symlink/hard link, TOCTOU,
programma fratello e catena di cammino sono chiuse (vedi i giri in fondo).

**Aperto per decisione ESPLICITA dell'utente (2026-10-01), non per
dimenticanza:** i comandi con destinatario opaco (`python3 -c`, `touch $(...)`,
script) passano da `ctx.ask` — «per ora lasciamo così e accetto il rischio».

Il testo sotto descrive la FASE 1 del 2026-09-24 e non riflette lo stato
odierno: i suoi "71 test verdi" sono oggi 25 test mirati + suite, e i vincoli
sono cablati in produzione (non piu' una difesa di libreria).

Modulo `packages/cyberstrike/src/permission/project.ts` + classi A/B/C in
`bash.ts`. 71 test verdi (unit + E2E con Instance reale), typecheck 11/11.

### Cosa esiste ora

- `classify(name)` → `read-only | write | opaque | unknown` con precedenza
  **OPAQUE > WRITE > READ_ONLY** (un comando in più liste è trattato nel modo
  più restrittivo)
- `pathCandidates(name, args)` → i path su cui il comando scrive, con tre
  semantiche di flag distinte (`writeFlags` introduce un path, `inPlaceFlags`
  lo attiva soltanto, `keyValueFlags` è `of=/x`)
- `ProjectPerimeter.diagnose(dir)` → `no-repo | project-in-repo |
  project-is-repo-root` con messaggio d'avviso
- `ProjectPerimeter.buildProjectRuleset(dir, worktree)` → il ruleset
- `isSafe(diagnosis)` → rifiuta il caso radice-di-repo
- `bash.ts`: nodi `file_redirect` letti da tree-sitter, comandi opachi →
  `ctx.ask({permission:"bash_unresolved"})`, path con `$VAR` → stessa conferma

### Difetti trovati scrivendo i test (e corretti)

1. **`find` era nella lista read-only** — ma `find / -delete` cancella file e
   `-exec` esegue qualunque cosa. Rimosso. Regola generale documentata nel
   modulo: un comando va in READ_ONLY solo se NON esiste una sua invocazione
   che scrive.
2. **`sed -i` trattato come flag che introduce un path** — produceva
   `["s/a/b/", "/etc/hosts"]`, cioè un candidato fantasma (l'espressione di
   sed) su cui poi girava un `realpath`. Separati `writeFlags` e `inPlaceFlags`.
3. **`dd of=/tmp/x` raccoglieva anche `if=` e `bs=`** — un candidato che non è
   un path. Aggiunto `keyValueFlags`.
4. **L'argomento consumato da un flag veniva raccolto due volte** (`curl -o
   /tmp/out` dava `/tmp/out` duplicato). Aggiunto `i++`.
5. **Il pattern relativo con `rel === ""` produceva `/*`**, che non matcha
   nulla: il perimetro negava anche l'interno. (Il caso resta comunque
   rifiutato da `diagnose()`: vedi sotto.)

### Sulla sicurezza del caso "progetto = radice di un repo" — VERIFICATO

Non è aggirabile con un pattern migliore. Misurato con `Wildcard.match`:

```
pattern relativo "*"   -> matcha "state.json"  E  "../../../etc/passwd"
pattern relativo "/*"  -> non matcha NESSUNO dei due
```

Non esiste forma relativa che distingua interno ed esterno. Da qui il rifiuto
in `diagnose()`: il caso non va "gestito", va impedito.

### Cosa NON è ancora verificato

- **E2E dentro una sessione reale** con l'agente che tenta davvero una
  scrittura fuori progetto: richiede `bb hunt` (ticket #4), che non esiste
  ancora. I test attuali esercitano `Instance` + `PermissionNext.evaluate` +
  i pattern veri dei tool, ma non il ciclo completo tool→sessione→DB.
- L'attrito reale di `bash` (quante conferme riceve l'utente in un hunting
  vero): si misura solo con l'uso.

---

## Question

Imporre meccanicamente che l'agente NON possa scrivere fuori dalla directory
del progetto, lasciando la lettura libera.

## Scoperta 1: il canale per-sessione esiste GIÀ

`session.createNext()` accetta già `permission?: PermissionNext.Ruleset` e lo
persiste in DB (colonna `permission` di `SessionTable`):

- `src/session/session.sql.ts:29` — `permission: text({mode:"json"}).$type<Ruleset>()`
- `src/session/index.ts:267` — `createNext({ ..., permission?: PermissionNext.Ruleset })`
- `src/session/index.ts:394` — path di aggiornamento

Il ruleset attivo è la fusione agente + sessione:

```
src/session/prompt.ts:1091
  ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? [])
```

`merge` è order-based e `evaluate()` usa `findLast` (`next.ts:240`) → **la
sessione vince sull'agente**. Non serve un agente speciale "con poteri
limitati": `bb hunt` imposta `session.permission` alla creazione della sessione
e il perimetro vale per quella sessione, con qualunque agente.
Granularità corretta: perimetro della **sessione**, non dell'agente.

## Scoperta 2: il ruleset richiede ENTRAMBE le forme del pattern

`write.ts:36` e `edit.ts:61` mandano `patterns: [path.relative(Instance.worktree, filepath)]`
— RELATIVI al worktree. `external-directory.ts` manda glob ASSOLUTI.
Col solo pattern assoluto il perimetro nega anche la scrittura DENTRO il
progetto (verificato: primo tentativo, tutto `deny`, interno incluso).

```ts
// forma corretta, verificata con test reale su Wildcard.match
[
  { permission: "edit",               pattern: "*",                             action: "deny"  },
  { permission: "edit",               pattern: "bcny/*",                        action: "allow" },
  { permission: "edit",               pattern: "/home/marco/bugbounty/bcny/*",  action: "allow" },
  { permission: "external_directory", pattern: "*",                             action: "deny"  },
  { permission: "external_directory", pattern: "/home/marco/bugbounty/bcny/*",  action: "allow" },
]
```

Esito test:
```
✅ edit  dentro (relativo)          bcny/state.json
✅ edit  sotto (relativo)           bcny/crawls/2026.json
⛔ edit  fuori (relativo)           altro/file.txt
⛔ edit  sibling prefix            bcny-altra/state.json
✅ edit  assoluto dentro            /home/marco/bugbounty/bcny/state.json
⛔ edit  assoluto fuori             /home/marco/.ssh/config
⛔ external_directory glob interno  /home/marco/bugbounty/*
✅ external_directory glob progetto /home/marco/bugbounty/bcny/*
```

### Perché NON si deriva da `Instance.worktree`

`Instance.worktree` è la radice del **repo git** (`Project.fromDirectory`,
`src/project/project.ts:76`): cerca `.git` risalendo; se lo trova →
`sandbox = dirname(dotgit)`; **se NON lo trova → `{ id: "global", worktree: "/", sandbox: "/" }`**.
E `containsPath()` (`src/project/instance.ts:59`) fa `if (Instance.worktree === "/") return false`.

Conseguenza: lanciare in `~/bugbounty/bcny/` (senza `.git`) NON dà "scrittura
libera lì dentro, vietata fuori" — dà richiesta di conferma su OGNI file, perché
ogni path risulta "esterno". Il sandbox non aiuta: si disattiva.
`~/bugbounty/` non è un repo → motivo in più per impostare il perimetro
esplicito e usare pattern relativi alla DIR PROGETTO.

## Scoperta 3: ctx.ask con deny È contenimento

`PermissionNext.ask` (`next.ts:137`) su `rule.action === "deny"` →
`throw new DeniedError(...)`. Non è una richiesta: è un blocco. Il meccanismo
regge, il problema è solo far arrivare il pattern giusto a `ask`.

## Scoperta 4: il buco di bash è strutturale, non una svista

`bash.ts:130` rileva path esterni SOLO per una lista chiusa:
`["cd","rm","cp","mv","mkdir","touch","chmod","chown","cat"]`.
Ma esiste già un albero **tree-sitter** (`parser()`, `bash.ts:50`;
`tree.rootNode.descendantsOfType("command")`), quindi il rilevamento può essere
strutturale invece che testuale. Cosa espone il parser, verificato:

```
$ echo poc > /home/marco/.bashrc    → file_redirect: ["> /home/marco/.bashrc"]   ✅ rilevabile
$ echo poc >> /tmp/x                → file_redirect: [">> /tmp/x"]               ✅ rilevabile
$ tee /tmp/x <<< "data"             → file_redirect: []                          ⚠️  path è ARGOMENTO
$ sed -i 's/a/b/' /etc/hosts        → file_redirect: []                          ⚠️  serve conoscere il flag -i
$ python3 -c "open('/tmp/z','w')"   → file_redirect: []                          ❌ IRILEVABILE
$ cat /etc/passwd | tee /tmp/y      → file_redirect: []                          ⚠️  path è ARGOMENTO
$ curl -o /tmp/out https://...      → file_redirect: []                          ⚠️  serve conoscere il flag -o
$ target=~/x; echo y > $target      → file_redirect: ["> $target"]               ⚠️  variabile, non risolvibile
$ cp /etc/hosts /tmp/copia          → file_redirect: []                          ✅ lista chiusa (già coperto)
```

**`python3 -c`, `node -e`, `perl -e` sono irrilevabili per costruzione**: il path
è dentro una stringa, nessuna analisi statica lo trova. NON è risolvibile con
più parsing — va accettato e coperto diversamente.

## Soluzione scelta: opzione (c) — classificare il COMANDO, non il path

L'idea che rende (c) solida: **non serve rilevare il path, serve classificare il
comando**. Tre classi:

| Classe | Azione | Esempi |
|---|---|---|
| **A. Read-only noto** | `allow` | `ls cat grep find head tail wc stat file which dig` … |
| **B. Scrittura nota** | path → `ask`; fuori progetto → `deny` | `cd rm cp mv mkdir touch chmod chown tee sed -i curl -o wget -O` + nodi `file_redirect` |
| **C. Non classificato** | `ask` | `python3 node perl ruby go php` e qualunque comando nuovo |

- **Classe A** → attrito zero sui comandi di ricognizione (il grosso dell'uso
  reale durante un hunting).
- **Classe B** → rilevamento *strutturale* (tree-sitter): nodi `file_redirect`
  + argomenti della lista chiusa estesa.
- **Classe C** → `ask`. È qui che `python3 -c` viene coperto: non rilevo il path,
  chiedo conferma sul comando. L'utente può approvare in blocco ("always") nella
  sessione.

Risultato: nessun buco noto nel perimetro, e l'attrito cade sui comandi che
*effettivamente* possono scrivere in modo opaco. Non è un contenimento vero
(servirebbe seccomp/overlay): è una mitigazione con copertura dichiarata.

## Piano di implementazione in 2 fasi

Fasi separate per non bloccare `hunt-comando-entry-point` dietro una decisione
che richiede dati d'uso reali.

### FASE 1 — perimetro attivo (chiude questo ticket)
1. Modulo `buildProjectRuleset(projectDir, worktree)` → ritorna il `Ruleset`
   (entrambe le forme del pattern, come da Scoperta 2).
2. `bb hunt` lo passa a `session.createNext({ permission })`.
3. In `bash.ts`, classi A/B/C come sopra: deny fuori progetto, ask su classe C.
4. Test: unit su `buildProjectRuleset` + E2E su progetto bbtest/`localhost:4545`.

### FASE 2 — indurimento (ticket separato, dopo che `bb hunt` gira)
- Normalizzazione esplicita dei path (`path.resolve` prima del match) per non
  dipendere dalla normalizzazione incidentale di `path.relative()`
- Fix `external-directory.ts`: `path.join(path.dirname(filepath),"*")` calcolato
  PRIMA di normalizzare → produce `/home/etc/*` invece di `/etc/*`. Oggi innocuo
  (cade su deny `*`), con un ruleset diverso (`/home/*` allow) sarebbe un buco.
- Allowlist read-only estesa, guidata dai comandi realmente usati in fase 1.

## Decisioni utente (2026-09-24)

- Il vincolo riguarda **SOLO la scrittura**; la lettura resta libera (`read` è
  già `allow` e non filtrata: non va toccata)
- Il vincolo vale **anche per bash**
- Opzione **(c)** scelta: allowlist read-only + `ask` sui non classificati

## Aperto (non blocca il design)

1. **Dove vive il modulo**: proposto `packages/cyberstrike/src/permission/project.ts`
   (accanto a `next.ts`), consumato da `bb hunt`. Alternativa:
   `packages/hackbrowser/src/bugbounty.ts`. Il primo è più naturale: è
   infrastruttura di permessi, non di bug bounty.
2. **Progetto dentro un repo git**: il `worktree` diventerebbe la radice del repo
   → tutto il repo scrivibile. Vietare o accettare con avviso? (i repo di
   hunting esistono: un warning è probabilmente la scelta giusta)

## Limiti dichiarati (cosa il perimetro NON copre)

- `python3 -c`, `node -e`, `perl -e`, `bash -c '...'` e simili: scrittura opaca,
  coperta da `ask` sul COMANDO, non dal path
- Variabili non risolvibili staticamente (`echo x > $VAR`): path ignoto → il
  rilevamento può solo degradare ad `ask`
- Sottoprocessi lanciati da uno script in classe A/B
- Non è un contenimento a livello kernel: un binario che scrive fuori progetto
  viene fermato dal gate di classificazione, non dal SO

## Pattern già in uso nel repo (riferimento)

L'agente `explore` usa `"*": "deny"` + allow selettivi (`src/agent/agent.ts:221`).
Il modello "tool limitati con deny + allow selettivi" è già praticato: non
serve inventarlo.

## Dipendenze

Prerequisito di [stato-progetto], [agente-bounty-prompt-iniziale],
[hunt-comando-entry-point]. Nessuna dipendenza a monte.
---

## Verifica indipendente (2026-09-25)

Due revisori indipendenti hanno attaccato il perimetro con mandato avversariale
(cercare buchi, non confermare il caso felice). Hanno trovato **5 difetti reali**,
tutti riprodotti e poi chiusi. Il primo era grave.

### Buchi trovati e chiusi

1. **CRITICO — redirect senza comando = zero controlli.** Tree-sitter parsa
   `> /tmp/x` come `redirected_statement` senza figlio `command`. Il rilevamento
   viveva dentro `descendantsOfType("command")`, quindi non entrava mai:
   `> ~/.bashrc` **troncava a zero** il file senza nemmeno una richiesta.
   *Fix*: i `file_redirect` sono raccolti a livello di albero, fuori dal loop
   sui comandi; l'estrazione usa il campo `destination`.

2. **CRITICO — `always: ["*"]` cancella il perimetro.** `write.ts`/`edit.ts`
   chiedono `always: ["*"]`; un click "sempre" su una scrittura interna
   aggiungeva `{edit,*,allow}` in coda, e `evaluate` (`findLast`) lo faceva
   vincere su tutto. Il perimetro spariva per il resto della sessione.
   *Fix*: in `PermissionNext.ask`, al momento di registrare un `always`, i
   pattern che coprono tutto vengono esclusi se il ruleset attivo contiene un
   `deny` sulla stessa permission. Il ruleset viene conservato in `pending`.
   Verificato: dopo l'always, la scrittura esterna è ancora `deny` e quella
   interna ancora `allow`.

3. **Path dinamico non confinato.** `echo x > $VAR` non produceva alcuna
   richiesta dedicata. Peggio: `echo x > "$VAR"` (quoted) passava per `realpath`,
   che risolve il **literal** e lo considera dentro il progetto → il target
   quoted e solo dentro. Stessa cosa per `$VAR/y`, ridotto al frammento `/y`.
   *Fix*: se il `destination` è un nodo di espansione (`simple_expansion`,
   `expansion`, `command_substitution`) va in `unresolved` **prima** di
   `realpath`. Verificato su tutte e 4 le forme.

4. **`realpath` fallito scartato in silenzio.** Un path non risolvibile usciva
   dal controllo senza traccia. *Fix*: entra in `unresolved`.

5. **Metacaratteri glob nel nome del programma.** `Wildcard.match` traduce `*`
   in `.*` senza escape, e l'escape non esiste (`\\*` diventa `\\.*`). Un nome
   come `bcny*` generava un allow che copriva anche i programmi sorella.
   *Fix*: `globMeta()` — il nome con `*`, `?`, `[`, `]` è rifiutato da
   `diagnose` e rifiutato di nuovo in `buildProjectRuleset` (difesa in
   profondità). `isSafe` è passato a lista positiva, così un rischio nuovo
   è rifiutato di default.

### Falso positivo, verificato e respinto

Il revisore ha segnalato come regressione che `cat /etc/passwd` non chiede più
`external_directory`. **Non è una regressione: è il requisito.** Sotto il
perimetro `external_directory` è `deny`; con la vecchia lista chiusa `cat`
veniva trattato come scrittura, quindi la **lettura** fuori progetto sarebbe
stata negata — l'opposto di "leggere ovunque, scrivere solo nel progetto".
Il test `bash.test.ts` che asseriva il vecchio comportamento è stato riscritto.

### Verifiche mie (esecuzione reale, non deduzione)

- `test/permission/perimeter-containment.test.ts` — il gate reale
  (`PermissionNext.ask`) lancia `DeniedError` su scrittura esterna, lascia
  passare quella interna; una scrittura vera riesce dentro e il file fuori
  **non esiste**; lettura libera verificata su `/etc/hostname`, `/etc/shadow`,
  `~/.ssh/id_rsa`.
- `test/permission/session-perimeter.test.ts` — ciclo modulo → `session.createNext`
  → DB → rilettura → merge con i permessi dell'agente. Il perimetro vince anche
  con un agente permissivo. Fissa il contratto: `buildProjectRuleset` deve
  ricevere **lo stesso `worktree` di `Instance`**.
- `test/permission/perimeter-hardening.test.ts` — i buchi 2 e 5.
- `test/tool/bash-perimeter-probe.test.ts` — `execute()` reale su 13 comandi.

### Ancora non verificato

- Attrito reale di `bash` in un hunting vero (quante conferme si ricevono)
- E2E con `bb hunt` completo: il comando non esiste ancora
- Nessun contenimento a livello kernel (dichiarato sopra)

## V11 (2026-09-27) — NON PASSA. Il buco reale non e' quello dichiarato.

Due subagent in parallelo (`deleg_37d605ce`). Il primo accende il container e
prova; il secondo verifica il codice e scrive i criteri anti-verde-falso. Il
secondo ha prodotto la parte piu' utile: **quattro criteri** per distinguere un
blocco vero da un verde falso.

### Cosa ha trovato il test sul container (subagent 1, 15 API call, 432s)

| path | esito | risposta |
|---|---|---|
| `/etc` | negato | `Permission denied`, stato 1 |
| `/root` | negato | `EACCES: permission denied` |
| `~/.ssh` (home del container) | **SCRITTO** | stato 0, file creato, recuperato con `docker cp`, 15 byte |

Il subagent ha correttamente notato che l'errore su `/etc` e `/root` e' un
`EACCES` da utente non privilegiato, **non** un confine: quei path non sono
protetti da niente, sono solo inaccessibili a `hunter`.

### Il ritrovamento che il subagent ha mancato

Il mount e' `-v "$BB_ROOT":/work/bugbounty:rw`. E dentro `BB_ROOT` ci sono i
file di **tutti** i programmi, non solo di quello in caccia:

```
~/.cyberstrike/bugbounty/
  credentials.json      600   marco(1000)   <- credenziali di TUTTI i programmi
  bcny.json             664
  smoketest.json        664
  bookingcom.json       664
  programs/             <- bcny E bcny-test insieme
```

`credentials.json` e' dentro un mount in lettura-scrittura, e il file e' del
proprietario del mount. Quindi l'agente che lavora su `bcny` puo' **leggere e
riscrivere le credenziali degli altri programmi** — inclusi programmi che non
gli sono stati assegnati. Il perimetro applicato da `bb hunt` copre
`programs/bcny/`, ma il mount non copre `BB_ROOT/`.

Non e' un escape dal container: e' **una fuga laterale fra programmi**. Per un
workflow bug bounty e' la piu' grave delle due, perche' un programma ne puo'
leggere le credenziali di un altro.

### Cosa coprirebbe davvero

Non `--read-only`: quello renderebbe il container inutilizzabile (il TUI scrive
in `/home/hunter/.local` e in `/work`). Il giusto e' **montare piu' directory
strettamente invece di una larga**:

- `/work/bugbounty/programs/<programma>` -> rw (serve per il lavoro)
- `/work/bugbounty` -> ro, o niente
- `credentials.json` -> mai montato; e sufficiente montare solo
  `<programma>.json`, `<programma>.accounts.json` e `<programma>.policy.md`

Questo e' incompatibile con l'attuale `bb hunt`, che risolve i config dalla
root perche' ne conosce il nome a runtime. Da rifare in modo esplicito.

### Stato dei criteri anti-verde-falso (subagent 2, 12 API call, 277s)

Quattro criteri, il piu' importante e' il secondo:

1. usare i tool CyberStrike, non `touch` di sistema;
2. **controllo positivo dentro il progetto**: se il tool non riesce a scrivere
   nemmeno dentro, il test non prova niente — altrimenti un tool rotto passa
   per sicuro;
3. annotare tool, path effettivo ed esito (deny / ask / eseguito): un `EACCES`
   e' un blocco del sistema operativo, non del perimetro;
4. controllare il path **dentro** il container e la destinazione **sull'host**:
   un canary assente solo nel path sbagliato non prova niente.

Il criterio 2 e' quello che mancava al test di sopra: nessuna scrittura di
controllo dentro il progetma. Senza, "nessun file fuori" e' indistinguibile da
"nessun file scritto".

### Altre vie aperte, dal codice (subagent 2, non ancora testate)

- **symlink**: `assertExternalDirectory` usa `Instance.containsPath` **senza
  canonicalizzare** (`external-directory.ts:17`). Un symlink dentro il progetto
  che punta a `/etc` passa il controllo e la scrittura segue il link.
  `apply_patch` normalizza `..` con `path.resolve` ma non segue i symlink.
- **TOCTOU**: nessuna protezione atomica fra controllo e scrittura in `write.ts:27`,
  `edit.ts:45` e `apply_patch.ts:62`.
- **path dinamici in bash**: `$HOME`, `$TMPDIR`, command substitution finiscono
  in `bash_unresolved` e **chiedono conferma, non negano**
  (`bash.ts:296-308`). E `bash -c` e gli script sono opachi → chiedono conferma.
- **`~` non e' espanso dai tool file**: `~/.ssh/x` viene unito alla directory
  del progetto (`write.ts:26`), quindi il modello crede di scrivere in home e
  scrive in progetto.

### Verdetto

**V11 non passa.** Non per `/etc` o `/root` (che non sono mai stati protetti),
ma per due motivi veri:

1. la home del container e' scrivibile, quindi il "fuori" esiste ed e' usabile;
2. `BB_ROOT` e' montata in `rw` e contiene le credenziali di **tutti** i
   programmi: fuga laterale fra programmi, piu' grave del rischio di scrittura
   arbitraria per un workflow bounty.

Nessuna modifica ai file, container di prova rimosso, 0 residui.

---

## V17 — chiusura di due punti (2026-10-01)

Questo verdetto **non annulla** quello sopra: V11 resta la base (la home
scrivibile, il resto delle vie aperte). Qui si chiudono due punti e si
riconosce esplicitamente cio' che resta scoperto.

### 1. La `tmp/` del programma — FATTO

`bb-program-docs.ts` crea ora `programs/<programma>/tmp/` a ogni refresh dei
documenti del programma, e `AGENTS.md` la dichiara l'unica zona scrivibile per
i file di caccia (PoC, payload, script, output).

Non serve alcuna regola di permesso nuova: la `tmp` sta *dentro* la directory
del programma, quindi eredita il confine gia' esistente. Il vantaggio e' di
separazione — l'agente ha un posto dichiarato dove mettere la roba, e tu sai
dove guardare.

Misura: `test/cli/bb-program-docs.test.ts` 10/10, controprova rossa prima
dell'implementazione (2 fallimenti sui due assunti nuovi, gli altri 8 verdi).

### 2. Config del container in sola lettura — FATTO, con una riduzione

`run-sandbox.sh` montava `VOL_CFG` in `rw`. Ora e' `ro` (riga 476).

**Cosa dice la misura, e va detto prima del resto:** dentro quel volume c'e'
**solo** `cyberstrike.json` — il provider e il modello. Nessuna credenziale:
quelle stanno in `~/.cyberstrike/` e non sono montate. Quindi il rischio reale
era "l'agente altera come si comporta la sessione successiva", non "l'agente
ruba segreti". Questo ridimensiona il punto rispetto a com'era stato
descritto, e la modifica non lo chiude del tutto: la modifica non
sopravvive al container, ma l'effetto (config alterata) sì.

L'avvio non si rompe: `global/index.ts:30` chiama
`fs.mkdir(Global.Path.config, {recursive:true})`, e `mkdir -p` su una
directory gia' esistente non lancia **nemmeno in sola lettura** — misurato,
non supposto. `Global.Path.config` e' `XDG_CONFIG_HOME/cyberstrike` e quella
sottocartella esiste gia' nel volume. `bb hunt` con `--dry-run` gira con
`RC=0`, senza `EROFS`.

**Test:** `infra/bounty-sandbox/verify-v17-config-readonly.sh`, che verifica
i quattro percorsi di scrittura (tre espliciti, uno opaco), un **controllo
positivo** nella `tmp` del programma e in `csdata`, e l'avvio di `bb hunt`.

Controprova: riportato a `rw`, il test diventa rosso con 4 `SCRITTO` e 0
`NEGATO`. Ripristinato `:ro`, verde.

### Due errori commessi durante il lavoro, e cosa ne resta

**Il mio test 3 era un falso verde.** Nella prima stesura il subshell
stampava `OK` incondizionatamente e il verdetto passava da un
`grep '^OK'` su quella riga: vero anche a volume corrotto. Ora il verdetto
viaggia nel **codice di uscita**. Controprovato su tre casi: integro `rc=0`,
`cyberstrike.json` corrotto `rc=1`, file di prova presente `rc=1`.

**La controprova ha corrotto il volume vero, e per poco.** I miei comandi di
prova includevano `echo SCRIVI >> cyberstrike.json` e `>> .gitignore`. Con il
mount in `rw` quei due file si sono riempiti di testo spazzatura. Mi sono
accorto controllando il volume dopo la controprova, non prima. `cyberstrike.json`
e' risultato intatto (414 byte, primo carattere `{` — l'`>>` in coda a un JSON
valido lo lascia valido, il file e' stato solo accorciato dal test); `.gitignore`
e `PROVA_OPACA` sono stati riparati a mano. Il test 3 e' stato riscritto per
guardare l'**integrita'**, non solo l'assenza di residui — che era esattamente
la verifica che mancava e che aveva lasciato passare il danno.


### Terzo difetto, trovato dal subagent: il test 2 accettava qualunque esito

Il subagent avversariale ha eseguito la controprova del test riportando
`run-sandbox.sh` a HEAD (quindi con la config di nuovo in `rw`) e volume
usa-e-getta. Il test e' andato rosso come deve — ma nel suo output c'era una
riga che non avevo previsto: `RC=1` marcata **`ok`**.

Il motivo e' che il test 2 accettava **qualsiasi** codice di uscita, e
soltanto si accorgeva di `EROFS`/`Permission denied`. Dichiarava quindi
`ok` anche con `rc=139` (crash) e anche con output del dry-run assente
(il comando era mascherato da un `true` finale). **Il test di
non-regressione non misurava niente**: poteva essere verde mentre `bb hunt`
era morto.

Misurato prima della correzione, con il blocco estratto e alimentato a mano:

```
test 2 con bb hunt FALLITO (rc=1, nessun EROFS)  ->  ok  FAIL=0
test 2 con rc=139 (crash)                       ->  ok  FAIL=0
test 2 con nessun output per crash silenzioso    ->  ok  FAIL=0
```

Ora il `:ro` non deve cambiare l'esito di `bb hunt`, quindi l'unico rc
accettabile e' `0`, e non basta: serve anche che il dry-run abbia stampato
l'output atteso. Controprovato su cinque casi, tutti corretti:

```
OK SANO: rc=0 + output    OK CRASH: rc=139    OK FALLIMENTO: rc=1
OK SILENZIOSO: solo rc=0  OK EROFS
```

Rilanciato V17 per intero dopo la correzione: verde, con la riga 2 ora
`ok  bb hunt ha girato (rc=0) e ha stampato il dry-run, senza EROFS`.

**Questo e' il terzo difetto mio in un solo ticket**, tutti e tre falsi verdi
nei test che avrebbero dovuto misurare la modifica. Il pattern e' sempre lo
stesso: `bash` senza `set -e`, verdetto in una stringa e non nel codice di
uscita, e l'assenza di un errore specifico scambiata per successo. E' il
motivo per cui la verifica non puo' restare mia.

### Cosa resta aperto — e non e' aggirabile

Il buco vero, quello che il perimetro non chiude, sono i **comandi Bash di cui
non si puo' determinare il destinatario**: `python3 -c "open('/tmp/x','w')"`,
`touch $(echo /tmp/x)`, `bash -c '...'`, gli script. Questi arrivano a
`ctx.ask` (`tool/bash.ts:296-308`): un "si" umano apre il confine, e il
confine si sposta con ogni conferma.

Ho verificato che le scritture **esplicite** fuori non sono un buco: `rm -rf
/tmp/x`, `echo > /etc/x`, `sed -i`, `curl -o` sono gia' negati da
`external_directory` senza chiedere nulla. La premessa del piano precedente
("fuori chiede conferma") era **falsa** e l'ho corretta prima di scrivere.

Chiudere il caso opaco richiede una decisione che spetta a te, perche' la
risposta piu' restrittiva (negare) si porta dietro `python3`, `node`, `bun`,
`perl`, `ruby`, `php`, `bash`, `sh`, `docker` — cioe' gli strumenti con cui si
fa caccia. Negarli significa che l'agente non puo' piu' eseguire quasi nulla.
Non posso consegnare quello dicendo che era la specifica.

Restano inoltre aperti i punti gia' elencati sopra e non toccati qui:
**symlink** non canonicalizzato (`external-directory.ts:17`), **TOCTOU** fra
controllo e scrittura (`write.ts:27`, `edit.ts:45`, `apply_patch.ts:62`),
**`~` non espanso** dai tool file (`write.ts:26`).

**Nessuna modifica ai file di programma, 0 container di prova residui.**

## Difetti trovati dal subagent avversariale (deleg_cb90184f) e chiusi nello stesso giorno

Il subagent doveva trovare il buco. Ne ha trovati tre, tutti misurati, e due
erano difetti miei. Chiusi in questa stessa sessione, con controprova per ognuno:

1. **`tmp/` come symlink veniva seguita** (RIPRODOTTO, mio). `mkdirSync` su un
   percorso che e' un symlink esce con codice 0 e non tocca il link: la
   cartella puntata restava scrivibile e fuori dal perimetro. Rilevato ora con
   `lstat`, e i permessi vengono riportati a 0700 invece di restare 0777.
2. **Il test V17 guardava il volume sbagliato** (RIPRODOTTO, mio). Il controllo
   d'integrita' ispezionava `cyberstrike-config` scritto a mano nella riga del
   `docker run`, non il volume che il launcher aveva montato: poteva certificare
   un volume mai toccato. Ora il volume e' usa-e-getta, passa al launcher via
   `VOL_CFG`, e il controllo legge lo stesso volume.
3. **Il controllo positivo del test V17 era falsificabile** (RIPRODOTTO, mio).
   Contava le righe `SCRITTO:` senza verificarne la provenienza: bastava
   sostituirle con due righe prefabbricate. Ora si pretendono i due percorsi
   esatti, per nome.
4. **Il test di non-regressione accettava qualunque esito** (RIPRODOTTO, mio).
   `bb hunt` che esce con 139 o che non stampa nulla venivano dichiarati `ok`,
   perche' la condizione guardava solo l'assenza di `EROFS`. Ora si richiede
   `rc=0` e l'output del dry-run: controprovato su cinque casi (139, vuoto,
   assenza di output, EROFS, sano).
5. **Il test lasciava un residuo** sull'host: `PROVA_POS` dentro
   `programs/<prog>/tmp/`, che e' persistente. Ora il cleanup lo rimuove.
6. **Corruzione del volume durante la controprova** (RIPRODOTTO, mio, contro me
   stesso). I comandi di prova scrivevano dentro `cyberstrike.json` e
   `.gitignore` reali. Me ne sono accorto ispezionando il volume DOPO, non
   prima: e la verifica che mancava. Il file di configurazione e' risultato
   intatto, `.gitignore` riparato a mano. Da allora il test 3 verifica
   l'integrita', non solo l'assenza di sporco.

Nessun bypass del `:ro` trovato dal subagent: ha provato accesso diretto,
`/proc/self/root`, hard link, symlink, bind mount a runtime, file descriptor
descriptor e rename della directory. Tutti respinti; il parent scrivibile non
permette di attraversare il mount.

## `--dry-run` e il confine: rettifica di una mia affermazione

In una prima stesura ho scritto che la MAP contraddiceva il codice su
`--dry-run`. **Ho esagerato, e lo correggo.** La lettura precisa di
`bb.ts:838` mostra che il difetto a cui la MAP si riferisce — lo stato scritto
in dry-run — **e' chiuso**: `if (!state && !args.dryRun)` esclude davvero la
creazione di `state.json`.

Quello che resta e' un'altra cosa, e il codice la dichiara **intenzionale**
(`bb.ts:851-854`): in `--dry-run` vengono comunque riscritti `AGENTS.md` e
`scope.md`, perche' senza quel `mkdir` il dry-run falliva con ENOENT e non
mostrava niente proprio nel comando che serve a ispezionare. Con questa
modifica si aggiunge `tmp/` alla stessa sorte.

MISURATO: `--dry-run` crea `programs/<prog>/` con `AGENTS.md`, `scope.md` e
`tmp/` (mode 700), e restituisce `rc=0`. Controprovato a HEAD: **scriveva
anche prima** — non e' una regressione introdotta qui.

Non e' quindi una contraddizione da sanare, ma una **scelta di prodotto
esplicita** che ha un prezzo: `--dry-run` non e' privo di effetti sul disco.
Se quel prezzo non e' voluto, la decisione e' dell'utente; io non l'ho
cambiata.

Verdetto: il perimetro di scrittura e' chiuso per cio' che e' dimostrabile
con un percorso esplicito e per la configurazione del container. Resta aperto
il caso dei comandi con destinatario opaco (che chiedono conferma) e il
dry-run che scrive.

## BYPASS reale trovato dal 2o verificatore (`deleg_6dc3ac19`) — CHIUSO

Il primo verificatore ha trovato che `tmp/` era protetta. **Il secondo ha
trovato che non lo erano le due righe accanto.** Avevo messo una toppa e
lasciato il buco accanto alla toppa.

`writeFileSync` **segue i link**. Misurato: con `programs/bcny/AGENTS.md` e
`scope.md` resi symlink verso una directory esterna,
`bb hunt bcny --dry-run` usciva **`rc=0`** e scriveva **979 + 757 byte FUORI**
dal progetto. Riprodotto da me, con l'entry point reale, non in un test
isolato.

**Chiusura, e perche' cosi' e non con un controllo.** La garanzia non e' un
`lstat` prima della scrittura — quello sarebbe aggirabile con una corsa fra
controllo e scrittura (TOCTOU). E' la FORMA della scrittura: il contenuto va
in un file nuovo nella stessa directory (`flag: "wx"` = `O_CREAT|O_EXCL`, che
non segue un link) e poi `rename` **sostituisce la voce di directory**. Cosi':

- un **symlink** viene rimpiazzato e il file esterno resta intatto;
- un **hard link** perde la sua voce e l'inode esterno **non viene toccato**
  (un controllo sul tipo non lo avrebbe mai visto: un hard link e' un file
  normale per `lstat`).

**Controprova**: riportate le due scritture a `writeFileSync` nudo (come a
HEAD), i test mirati vanno **3 rossi** (symlink AGENTS, symlink scope, hard
link). Col codice corretto: **17 verdi, 0 rossi**. E passando dall'entry point
reale: 0 byte fuori, il link sostituito, i 979 byte nel file giusto dentro il
progetto.

## TERZO vettore, trovato da me misurando — CHIUSO

Nessuno dei due verificatori l'aveva tentato. Se e' la **DIRECTORY DEL
PROGRAMMA** a essere un link, ogni scrittura "dentro" finisce fuori: la difesa
sui nomi dei file non lo copre.

MISURATO con l'entry point reale: `programs/bcny` reso symlink a
`/tmp/outdir-...`, poi `bb hunt bcny --dry-run` -> `rc=0` e `AGENTS.md`,
`scope.md`, `tmp/` creati DENTRO la cartella esterna.

Chiuso alla radice, non per-file: `assertInsidePrograms` confronta il percorso
**reale** (`realpath`) con `programs/`. Godimento collaterale: il messaggio di
rifiuto e' visibile all'agente, non silenzioso — misurato nell'output reale:
`! non ho potuto scrivere i documenti del programma: ... risolve a ... che e'
FUORI da ...`. Il caso normale continua a funzionare: `AGENTS.md`, `scope.md`,
`tmp` creati, `rc=0`.

**Controprova**: rimossa la guardia, il test dedicato va **1 rosso** (e gli
altri 17 verdi); con la guardia, **18 verdi, 0 rossi**.

## Tre difetti MIEI, trovati mentre chiudevo il terzo vettore

1. La funzione di guardia usava il nome della FUNZIONE `lstatSync` come TIPO
   (`lstatSafe(p): lstatSync | undefined`): rotto, corretto con `Stats`.
2. La guardia lanciava `ENOENT` sul caso NORMALE (directory del programma non
   ancora creata), facendo passare per guasto cio' che era la prima esecuzione.
   Corretto con `realpathDeep`, che risolve il primo antenato esistente.
3. I MIEI test passavano `"/programs"` — un percorso fittizio che non esiste —
   mentre la directory stava sotto una tmp. Sei test sono diventati rossi
   appena ho aggiunto la guardia, ed erano SCIATTI LORO: ora passano il
   percorso vero. Una guardia seria ha smascherato dei test scritti male.

## Quinta iterazione (2026-10-01) — quarto verificatore indipendente (deleg_b41be483)

**Due difetti riprodotti, entrambi chiusi.**

1. **TOCTOU sul percorso del programma** (gravita' alta). `assertInsidePrograms`
   risolveva il percorso PRIMA delle scritture, ma le syscall riaprono il
   percorso testuale: chi alterna `programs/<prog>` fra directory e symlink
   verso fuori fa uscire la scrittura. Riprodotto dal subagent con un harness
   concorrente (15.000 chiamate, `escapedAt: 41`, file scritto fuori).
   Riprodotto anche da me sul caso NON concorrente: con `programs/` stessa
   resa symlink, `realpath(programs)` e `realpath(directory)` risolvono
   ENTRAMBI fuori, quindi il confronto passava e si scriveva fuori.
2. **File `.tmp` orfano** nel percorso esterno dopo un fallimento a meta'.

**Chiusura — cambio di forma, non un altro controllo.** `withAnchoredDir`:
la directory viene aperta una volta (`openSync`) e i file si scrivono
ATTRAVERSO `/proc/self/fd/N`, che il kernel lega all'inode aperto e non al
nome. Misurato:
- RENAME del nome: la scrittura resta sull'inode originale (dentro);
- DELETE + symlink: `/proc/self/fd/N` muore, la scrittura **fallisce con
  ENOENT** — fail-closed, nega invece di uscire;
- piattaforme senza `/proc`: fallback al percorso testuale (documentato).
Inoltre `assertInsidePrograms` rifiuta ora `programs/` symlink, e il `.tmp`
viene rimosso per nome vero, quindi non resta orfano.

**Controprova**: rimossi ancoraggio e guardia-radice, il test mirato va
**9 rosso / 13 verde**; ripristinato, 22/22.

## Danno provocato durante questo ticket (va detto)

Un mio probe nel sandbox conteneva `rm -rf` sul percorso del programma. Ha
**cancellato `AGENTS.md`, `scope.md` e `tmp/` del programma reale `bcny`** prima
di fallire sulla directory (rm cancella i file e fallisce solo sul mount point).
Riparati rigenerandoli dal config, che era intatto: 976 e 757 byte, tmp 0700.
Nessun dato di scope perso (i documenti si rigenerano; config e credenziali
intatti). Regola registrata nella skill di disciplina: dentro il sandbox ogni
prova distruttiva va fatta su una COPIA usa-e-getta, mai su un percorso reale.

**Falso verde mio, corretto**: il primo test dell'ancoraggio passava perche'
scattava il rifiuto, non perche' l'ancoraggio reggesse — misurava la cosa
sbagliata col nome giusto. Separato in due test che misurano ciascuno la
propria proprieta'.

**Misure finali**: test mirati 22/22; typecheck 11/11; suite 1862 pass,
5 skip, 1 fail (`grok-3`, preesistente e fuori ticket). Nessun residuo.

## 2026-10-01 — QUINTO giro: il link a un programma FRATELLO (deleg_3b5e0b49)

Difetto RIPRODOTTO, di classe diversa dai precedenti: non una fuga fuori dal
progetto, ma **da un programma all'altro**.

`assertInsidePrograms` confrontava solo il PREFISSO
(`realDir.startsWith(realPrograms + path.sep)`). Un link
`programs/bcny -> programs/other` resta SOTTO `programs/`, quindi passava:
`AGENTS.md` e `scope.md` di `other` sono stati SOVRASCRITTI con i dati di
`bcny`, `rc=0`.

Chiuso con un secondo invariante, non con l'allungamento del primo: la
directory deve essere la **figlia diretta** di quello che contiene il suo
nome. Misurato: tolta la guardia, 1 solo test rosso (quello del fratello);
gli altri 22 restano verdi.

### Errore MIO, e perche' la prima stesura non andava bene

La prima versione della guardia imponeva `realDir === programs/<nome>`, ma
`programsDir` NON e' la cartella dei programmi: il chiamante production
(`bb.ts:861`) passa `path.dirname(programsRoot)`, cioe' la **radice di
`bugbounty`**, dove vive anche la policy integrale. La stretta ha reso rossi
**tre** test end-to-end legittimi che lanciano `bb hunt` davvero, e un
controllo di perimetro che rompe il caso normale e' peggio di nessun
controllo. Riformulata con due invarianti che valgono comunque: dentro la
radice reale, e figlia diretta di chi contiene il suo nome.

### Stato dei residui

Nessuno. Test mirati 23/23, controprova 1 rosso, suite e typecheck verdi.

## 2026-10-01 — SESTO giro: il mio test non assomigliava alla chiamata REALE (deleg_014a4036)

Difetto RIPRODOTTO. `assertInsidePrograms` guardava se la RADICE
(`programsDir`) fosse un symlink, ma il chiamante production (`bb.ts:861`)
passa `path.dirname(programsRoot)` — la root di `bugbounty`, cioe' un
livello **piu' alto** di `programs/`. Quindi la cartella dei programmi
era un livello sotto e **nessun controllo la guardava**. Con `programs/`
reso symlink verso `bugbounty/archive/`, la scrittura finiva li' —
misurato anche da me: `ACCETTATO (sbagliato): {"files":["AGENTS.md","scope.md","tmp"]}`.

La parte peggiore e' del metodo, non del codice: **tutti i miei test
passavano `programs/` come terzo argomento**, mentre il comando vero passa
la root. Erano veri e il difetto era aperto. Un test che chiama una funzione
con argomenti diversi da quelli del chiamante production verifica un'API che
non esiste.

Chiuso senza imporre una profondita' fissa (che avrebbe rotto il caso
legittimo: `programs/<nome>` sono DUE livelli sotto la root — misurato, 3
test end-to-end sono tornati rossi). La regola e' piu' forte e non sa
nulla della profondita': **ogni componente del cammino, dalla root al
programma, deve essere una directory vera, mai un link**. Il cammino si
costruisce sul percorso TESTUALE, non su quello risolto.

Secondo errore MIO nella stessa correzione: la prima stesura camminava su
`realPrograms` (gia' risolto), dove il symlink e' sparito — quindi i 23 test
erano VERDI e il bypass era di nuovo APERTO. L'ho misurato prima di
dichiararlo chiuso: era l'unico modo di saperlo.

Controprova: tolto il controllo della catena, 1 solo test rosso (quello
della forma production) e i restanti 24 verdi.

## 2026-10-01 — SETTIMO giro: corsa che richiede root (deleg_4ba90e75) + decisioni dell'utente

Difetto RIPRODOTTO dal verificatore: un processo concorrente che sostituisce
la directory del programma con un symlink *durante* la scrittura fa ancorare
`/proc/self/fd/N` al target esterno (156 scritture fuori su 5.000 tentativi).

Gravita' MISURATA nel sandbox reale prima di decidere:
- `/work/bugbounty/programs` e' `drwxr-xr-x root root` -> l'agente (`uid=1000
  hunter`) NON puo' crearci ne' rinominarci voci (`PARENT-NON-SCRIVIBILE`);
- `/work/bugbounty/programs/bcny` e' un **mount point** (`/dev/nvme1n1p3 rw`),
  e sostituirlo richiede scrivere nel padre.
Quindi l'innesco richiede un processo con i permessi dell'utente sulla macchina:
non e' raggiungibile dall'agente. **Decisione UTENTE: lasciare aperto, rischio
accettato** (il perimetro efficace e' il mount, non il codice).

## RISCHIO ACCETTATO ESPLICITAMENTE (non e' un difetto chiuso)

Il requisito iniziale dell'utente era: «l'agente NON HA NESSUN POTERE DI
SCRITTURA AL FUORI DELLA DIRECTORY DI LAVORO» + «blocca bash/ogni comando
che possa scrivere fuori dal progetto».

Stato MISURATO oggi:
- path esterni espliciti -> `deny(external_directory)`, senza conferma. CHIUSO.
- comandi con destinatario opaco (`python3 -c "open('/tmp/x','w')"`,
  `touch $(echo /tmp/x)`, script) -> `ctx.ask`, quindi un'approvazione umana
  sposta il confine. **NON chiuso.**

Il 2026-10-01 l'utente ha deciso: «Per ora lasciamo cosi' e accetto il rischio».
E' una deviazione consapevole dal requisito iniziale, non un'opzione neutra:
chiudere significa negare anche `python3`/`node`/`bash`/`docker`, cioe' gli
strumenti con cui si caccia. Da rivedere se il costo dell'interruzione degli
strumenti diventa accettabile.
