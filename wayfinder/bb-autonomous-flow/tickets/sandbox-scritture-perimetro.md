# Ticket: perimetro di scrittura confinato al progetto (sandbox)

## Stato: ANALISI COMPLETA + soluzione verificata con test (2026-09-24). Pronto per implementazione.

## Question

Imporre meccanicamente che l'agente NON possa scrivere fuori dalla directory
del progetto, lasciando la lettura libera.

## Scoperta principale: il canale esiste GIÀ

`session.createNext()` accetta già `permission?: PermissionNext.Ruleset` e lo
persiste in DB:
- `src/session/session.sql.ts:29` — `permission: text({mode:"json"}).$type<Ruleset>()`
- `src/session/index.ts:267` — `createNext({ ..., permission?: PermissionNext.Ruleset })`
- `src/session/index.ts:394` — path di aggiornamento

E il ruleset attivo è la fusione agente + sessione:

```
src/session/prompt.ts:1091
  ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? [])
```

`merge` è order-based e `evaluate()` usa `findLast` (`next.ts:240`), quindi
**la sessione vince sull'agente**. Conseguenza: NON serve un agente speciale per
il perimetro — `bb hunt` imposta `session.permission` e il perimetro vale per
quella sessione, con qualunque agente.

## Perché NON si può derivare da `Instance.worktree`

`Instance.worktree` è la radice del **repo git** (`Project.fromDirectory`,
`src/project/project.ts:76`), non la cwd di lancio. Senza `.git` diventa
`{ id: "global", worktree: "/", sandbox: "/" }` e `containsPath()` ritorna
`false` per tutto (`src/project/instance.ts:59-63`) → sandbox di fatto
disattivata, ask su ogni file. Il perimetro va impostato ESPLICITAMENTE.

## Soluzione verificata (test reale con Wildcard.match)

`write.ts:36` e `edit.ts:61` mandano `patterns: [path.relative(Instance.worktree, filepath)]`
— quindi RELATIVI. `external-directory.ts` manda glob ASSOLUTI. Servono
**ENTRAMBE le forme** nel ruleset, altrimenti il perimetro nega anche l'interno
del progetto (fallimento dell'implementazione ingenua, verificato).

```ts
rules = [
  { permission: "edit",               pattern: "*",                        action: "deny"  },
  { permission: "edit",               pattern: "bcny/*",                   action: "allow" },
  { permission: "edit",               pattern: "/home/marco/bugbounty/bcny/*", action: "allow" },
  { permission: "external_directory", pattern: "*",                        action: "deny"  },
  { permission: "external_directory", pattern: "/home/marco/bugbounty/bcny/*", action: "allow" },
]
```

Esito del test:
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

## Traversal: NON sfruttabile, ma per caso

`bcny/../../../etc/passwd` → `path.relative()` lo normalizza a `../../etc/passwd`
→ non matcha `bcny/*` → cade su `deny *`. Salvato dalla normalizzazione di
`path.relative()`, NON da un controllo di traversal. Nessuna normalizzazione
esplicita in write.ts/edit.ts: il path va grezzo al matcher testuale.

**Residuo da sistemare**: `external-directory.ts` fa
`path.join(path.dirname(filepath), "*")` PRIMA di normalizzare → produce
`/home/etc/*` invece di `/etc/*`. Oggi innocuo (deny `*`), ma con un ruleset
diverso (es. `/home/*` allow) diventerebbe un buco.

## Il buco vero: bash

`bash.ts` rileva i path esterni SOLO per una lista chiusa (`bash.ts:133`):

```js
["cd","rm","cp","mv","mkdir","touch","chmod","chown","cat"]
```

`echo`, `tee`, redirezioni (`>`), `sed -i`, `python`, e qualunque altro comando:
**nessun controllo**. Quindi `bash: "allow"` vanifica il perimetro su edit.
Percorso esistente per i comandi in lista: `realpath` sull'argomento → se
`!Instance.containsPath` → `ctx.ask({permission:"external_directory"})`.

## Decisioni utente (2026-09-24)

- Il vincolo riguarda **SOLO la scrittura**; la lettura resta libera (read è già
  `allow`, non va toccata)
- Il vincolo vale **anche per bash**

## Da decidere (prima del codice)

1. **Robustezza di bash**: estendere la lista è fragile per costruzione (non è
   un contenimento). Alternative: (a) deny su pattern di comandi noti per
   scrivere, (b) `ask` per ogni comando non riconosciuto come read-only,
   (c) allowlist read-only + `ask` per il resto. Da scegliere con l'utente:
   quanto costa in attrito.
2. **Dove si costruisce il ruleset**: helper riusabile (proposto: in
   `packages/hackbrowser/src/bugbounty.ts`, prende il path progetto e ritorna il
   `Ruleset`) chiamato da `bb hunt`, o inline?
3. **Progetto dentro un repo git**: il `worktree` diventerebbe la radice del
   repo → tutto il repo scrivibile. Vietare o accettare con avviso? (nota:
   `~/bugbounty/` NON è repo → worktree `/` → motivo in più per impostare il
   perimetro esplicito e usare pattern relativi alla DIR PROGETTO, non al worktree)
4. **Verifica E2E**: tentare scritture fuori progetto con write, edit E bash
   dentro una sessione reale e registrare l'esito. Come automatizzarlo senza
   target terzi (target proprio: bbtest su :4545).

## Dipendenze

Prerequisito di [stato-progetto], [agente-bounty-prompt-iniziale],
[hunt-comando-entry-point]. Nessuna dipendenza a monte.

---

# Appendice: note di ricognizione originali

`Instance.worktree` è calcolato da `Project.fromDirectory()`
(`src/project/project.ts:76`):
- cerca `.git` risalendo (`Filesystem.up({targets:[".git"]})`)
- se lo trova → `sandbox = dirname(dotgit)` (quindi la radice del REPO, non la
  cwd di lancio)
- **se NON lo trova → `{ id: "global", worktree: "/", sandbox: "/" }`**

E `Instance.containsPath()` (`src/project/instance.ts:59`):
```js
containsPath(filepath) {
  if (Instance.worktree === "/") return false   // nessuna sandbox
  ...
}
```

Conseguenza: lanciare in `~/bugbounty/bcny/` (senza `.git`) NON dà "scrittura
libera lì dentro, vietata fuori" — dà richiesta di conferma su OGNI file, perché
ogni path risulta "esterno". Il sandbox non aiuta, si disattiva.

Meccanismo dei permessi (`src/permission/next.ts`):
- `Action = allow | deny | ask`; `Rule = {permission, pattern, action}`
- `evaluate()` → l'ULTIMA regola che matcha vince (order-based)
- `fromConfig()` espande `~/`, `$HOME/`
- i tool mandano i pattern: `write.ts` e `edit.ts` → `permission: "edit"`,
  `patterns: [path.relative(Instance.worktree, filepath)]`
- `external-directory.ts` → `permission: "external_directory"`, glob del parent
- `bash.ts` → `permission: "bash"`, patterns = testo dei comandi (parser, NON
  contenimento reale)

Pattern già in uso nel repo: l'agente `explore` ha `"*": "deny"` + allow
selettivi (`src/agent/agent.ts:221`). Quindi il modello "agente con tool
limitati" è già praticato — non serve inventarlo.

## Decisioni utente (2026-09-24)

- Il vincolo riguarda **SOLO la scrittura**; la lettura resta libera (read è già
  `allow`, non va toccata)
- Il vincolo vale **anche per bash**: i comandi che possono scrivere fuori dal
  progetto vanno bloccati o messi in conferma umana

## Direzione

1. **Non affidarsi al `.git`**: il perimetro di scrittura deve essere impostato
   ESPLICITAMENTE alla directory del progetto, non derivato dal repo. Il
   comportamento di default (nessun `.git` → `worktree "/"` → ask su tutto) va
   gestito, non subito.
2. **Ordine delle regole**: `edit: deny` su `*`, poi `allow` sul percorso del
   progetto (l'ordine conta, vince l'ultima). Idem `external_directory`, o ogni
   `~/...` chiede conferma.
3. **bash**: `bash: "allow"` vanifica qualsiasi blocco su write/edit (`echo >`
   scrive ovunque). Opzioni da valutare: deny sui pattern che toccano path fuori
   dal progetto, oppure `ask` condizionato al path rilevato nel comando.
   Il parser esistente (`Peril`/arity, blocco `--file-write`) non è un
   contenimento: va deciso quanto robusto deve essere.

## Da decidere

1. Dove si imposta il perimetro: nel config dell'agente bounty (permission
   ruleset), in `bb hunt`, o entrambi? (`bb hunt` deve garantirselo da sé)
2. Un progetto dentro un repo git cosa fa? Il `worktree` diventerebbe la radice
   del repo → tutto il repo scrivibile. Vietare progetti dentro repo, o
   accettare con avviso?
3. bash: deny sui path rilevati vs `ask` vs un elenco di comandi negati.
   Quanto deve essere robusto? (un parser non è un contenimento)
4. Verifica: come si PROVA che il perimetro regge — tentare scritture fuori
   progetto (dentro e fuori git) e registrare l'esito. Serve un test E2E.