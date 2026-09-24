# Ticket: perimetro di scrittura confinato al progetto (sandbox)

## Stato: PROGETTATO, pronto per implementazione in 2 fasi (2026-09-24)

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