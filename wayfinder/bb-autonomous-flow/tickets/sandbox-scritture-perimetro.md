# Ticket: perimetro di scrittura confinato al progetto (sandbox)

## Question

Imporre meccanicamente che l'agente NON possa scrivere fuori dalla directory
del progetto, lasciando la lettura libera. Oggi `Instance.worktree` (il
perimetro) NON è la directory da cui lanci il comando: è la **radice del repo
git**, e quando non trova `.git` la sandbox si disattiva del tutto
(`worktree: "/"`).

## Context — comportamento attuale, verificato nel codice

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