# La policy del programma e' fuori dal perimetro: l'agente non la puo' leggere

## Il fatto, misurato

Run `bcny` con `--auto` (2026-10-02, log `hunt-auto3.log`):

```
Read AGENTS.md   ->  AGENTS.md rimanda a /work/bugbounty/bcny.policy.md
Read /work/bugbounty/bcny.policy.md  ->  NEGATO dal perimetro
Osservazione dell'agente: "Non posso riassumerne i divieti ne' tentare un altro accesso."
```

La policy e' **montata e leggibile sul disco**, non e' un mount mancante:

| fatto | valore | dove |
|---|---|---|
| file su host | `~/.cyberstrike/bugbounty/bcny.policy.md`, 12719 byte | esiste |
| mount nel container | `/work/bugbounty/bcny.policy.md` ro | `run-sandbox.sh:245` |
| perimetro | `/work/bugbounty/programs/bcny` | `run-sandbox.sh:375` |
| esito | negato | run reale |

Quindi: `--perimeter` protegge il codice del programma e, nello stesso gesto,
**taglia fuori il suo contratto**. Non e' un bug di permessi, e' una
contraddizione fra due cose che il sandbox tenta di dare insieme.

## Perche' non si risolve allargando il perimetro

Il perimetro accetta **una sola radice** (`--perimeter` e `string`, non array)
e la sua progettazione e' deliberatamente stretta: `buildProjectRuleset`
rifiuta un `path.relative(worktree, dir)` che contenga salite, perche'
`../*` diventerebbe un pattern che risolve `../../etc/passwd`.

Quindi **non** si puo' fare `--perimeter /work/bugbounty`: includerebbe
tutti i programmi invece del solo `bcny` — esattamente il bug gia' corretto
in `0bc2156d0` — e le regole diventerebbero inutilizzabili.

## Opzioni, con costo

**A — copia dentro la directory del programma (scelta proposta)**
`bcny.policy.md` viene copiato in `programs/bcny/` dal seed, non montato a
parte. Il perimetro lo contiene gia' e l'agente lo legge.
- pro: nessuna modifica a `run.ts`, nessun indebolimento del perimetro
- contro: il file e' derivato, puo' divergere da quello in `.cyberstrike`
- contro: `programs/` e' rw, quindi l'agente puo' riscrivere la policy

**B — secondo mount + secondo perimetro**
Estendere `--perimeter` ad accettare piu' radici.
- pro: copre il caso generale, niente copie
- contro: tocca il cuore del confine, il file che ha piu' commenti di
  sicurezza del progetto; da fare per ultimo, con verifica avversariale

**C — link simbolico dentro il programma**
- **scartata**: `O_NOFOLLOW` protegge solo l'ultimo componente e i parenti
  restano seguibili; un symlink riporta fuori dal perimetro

**D — passare la policy nel prompt**
- **scartata**: 12719 byte finirebbero nel contesto come testo non verificato,
  e un prompt non e' un confine

## Piano

### 1. Rimuovere l'ambiguità (subito)
- rimuovere `tmp-operatore.ts`, mai eseguito e superato da `--auto`

### 2. Test di `--auto` (prima di qualunque commit)
`packages/cyberstrike/test/cli/run-auto.test.ts`, process-level con fake
OpenAI-compatible, riusando lo scaffolding di `run-perimeter.test.ts`:
1. `--auto` approva un `ask` (tool eseguito, risposta ricevuta)
2. `--auto` NON tocca un `deny`: il perimetro resta muro
3. senza `--auto` l'`ask` e' negato ed esce 1 (B, gia' verde)
3. il riepilogo finale elenca le approvazioni e nomina l'assenza di operatore

**Controprova obbligatoria a HEAD**: i test 1, 2 e 4 devono fallire senza la
patch. Un test che resta verde a HEAD non misura niente.

### 3. Scegliere A o B, poi implementare
Preferenza: **A**, perche' B modifica il file di sicurezza centrale per un
caso che A risolve. B solo se A non basta.

### 4. Verifica
- suite `packages/cyberstrike/test/cli` completa (104/104 attesi + i nuovi)
- `bun turbo typecheck` (11/11)
- **run reale su `bcny`**: l'agente deve leggere `scope.md`,|POLICY|
  e policy, e dire cosa e' vietato
- **subagent avversariale**: il perimetro deve ancora negare il path fuori
  dal perimetro (`/app/package.json`) e ogni altro programma

### 5. Commit e documentazione
- commit separati: `--auto` (feature) e policy (fix montaggio)
- aggiornare `MAP.md` e i ticket

## Regole che non si negoziano

- **`--auto` da solo non e' un confine.** Da solo `bash` e' in `ask` e
  `--auto` lo approva: via libera a comandi arbitrari. Va sempre con
  `--perimeter`.
- **un `deny` non e' una richiesta.** `--auto` approva solo `ask`; i `deny`
  non arrivano al loop e devono restare `deny`.
- **la policy non nel prompt.** 12719 byte in contesto non sono un confine.
- **ogni verifica passa da un subagent avversariale**, e ogni test di
  sicurezza e' controprovato riportando il codice a HEAD.
- **un solo processo pesante alla volta**, con `free -m` prima: il monitor
  parallelo ha fatto uccidere Hermes dall'OOM killer.
- **niente apostrofi in `INNER_SCRIPT`**: chiudono la stringa single-quoted
  (exit 127, misurato). `bash -n` NON lo intercetta.