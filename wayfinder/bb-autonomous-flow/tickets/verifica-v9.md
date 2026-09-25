# V9 — Verifica avversariale dei fix V8

**Stato: 12 difetti. 4 GRAVI confermati dall'autore su esecuzione, 1 falso positivo respinto, 1 difetto teorico.**

Data: 2026-09-26 · HEAD verificato `1dddd2f2c` · fix sotto verifica `9d7afe936` + `260e03516`

3 subagent indipendenti (`deleg_b065544b`, modello `auto/best-coding`), mandati separati.
L'autore non conta come verifica: i 4 difetti confermati qui sotto sono stati
**riprodotti con esecuzione** (`/tmp/probe-v9.ts`), non confermati per lettura.

---

## Quadro: cosa tiene e cosa cade

**Tiene** (confermato su esecuzione, area di task-1):
- `canonical()` accetta sia il path reale che il path-link per la stessa dir (A.1, A.2)
- normalizzazione di `..`, slash doppi, slash finale, `.` (B.1)
- `isHuntingDir`: solo figli diretti, file non-dir rifiutato, progetto spostato fuori
  dal layout resta riconosciuto (C.1–C.3)
- `presence()`: directory chiamata `state.json` e file `chmod 000` → `Unreadable`, stato
  **non** sovrascritto, nessun tmp orfano (D.2, D.3)
- **nessuna regressione sui progetti reali**: `bcny-test` letto con tutti gli spelling
  del sistema (E) — era la paura principale, non si è materializzata
- `derive()` su 5000 sessioni: ~18 ms (F.1)
- round-trip DB del ruleset: `boundary` **conservato** (A.c di task-1) — la domanda più
  importante della verifica, e la risposta è sì
- `fromConfig` non propaga `boundary` (A.b di task-1)

**Cade** — vedi sotto.

---

## Difetti GRAVI (confermati con esecuzione)

### G1. `env` in READ_ONLY: scrittura arbitraria esterna, nessun controllo — GRAVE

`project.ts:52` — `env` è nella lista `READ_ONLY`.

`classify("env") = "read-only"` (verificato). Il perimetro non chiama `pathCandidates`
per un comando read-only, quindi:

```
env touch /tmp/pwned
env cp /etc/hostname /tmp/x
```

non producono alcuna richiesta `external_directory`. Un click "sempre" su un
comando `env` concede **permanentemente** la scrittura ovunque.

È la stessa classe di `python3 -c "open(...)"`, cioè esattamente il vettore che
`OPAQUE` esiste per chiudere — `env` ci passa dritto sotto.

**Causa:** `env` è stato classificato come "stampa l'ambiente" (`env` senza argomenti),
ma con argomenti è un **wrapper generico**: `env CMD ARGS` esegue CMD.

### G2. `command_substitution` scartata nell'estrazione dei path — GRAVE

`bash.ts:168-176` — il ciclo sui figli del nodo `command` include `command_name`,
`word`, `string`, `raw_string`, `concatenation`. **Non** include
`command_substitution`.

```
touch $(echo /tmp/pwned)
```

→ `command = ["touch"]`, `pathCandidates("touch", ["touch"])` → `[]`, nessun path
controllato, nessun `unresolved`. Solo richiesta `bash`. Dopo un click "sempre",
secondo run: **0 prompt**, scrittura esterna concessa.

Idem per i backtick: `` touch `echo /tmp/pwned` ``.

**Causa:** il filtro dei tipi di nodo esclude per induzione i nodi che contengono
valori dinamici — che sono esattamente quelli che non si possono ispezionare
staticamente e devono finire in `unresolved`.

### G3. Il marcatore `boundary` è forgejabile da `approved` — GRAVE *se* il canale è aperto

`next.ts:169` — in `voidsBoundary`, `if (rule.boundary === true) return false`
disattiva il filtro **senza verificare nulla**.

Verificato su esecuzione:
```
evaluate("edit", "/etc/passwd", perim, [])
  → deny                              (corretto)
evaluate("edit", "/etc/passwd", perim, [
  { permission: "edit", pattern: "/etc/*", action: "allow", boundary: true }])
  → allow                             *** BUCATO ***
```

**Però la raggiungibilità non è dimostrata.** Ho verificato i tre canali che
popolano `approved`:

| canale | mette `boundary`? | fonte |
|---|---|---|
| click "sempre" | **no** — `approved.push` costruisce `{permission, pattern, action}` | `next.ts:357-363` |
| `fromConfig` | **no** — non popola il campo | `next.ts:59-74` |
| DB `approved` | **non esiste** — `approved` vive in `PermissionNext.state`, non è persistito | `next.ts:261-266` |

Quindi oggi il marcatore è **non raggiungibile dall'esterno**: nessun canale
pubblico lo scrive. Il difetto è reale ma è un'*arma carica*, non un buco attivo —
e diventa attivo al primo canale che lo propaghi (un export/import di ruleset, un
`Session.createNext` che erediti regole approvate, un futuro `approved` persistito).

**Decisione:** si chiude lo stesso, per due motivi. (1) È una difesa che dipende da
una proprietà *negativa* di quattro call site — se ne aggiungo un quinto, non me ne
accorgo. (2) Il costo è basso: `boundary` deve venire da `buildProjectRuleset`, non
da un campo che chiunque può scrivere.

### G4. `boundaryDenies` ignora il pattern: un deny stretto uccide allow lecite — DANNOSO

`next.ts:189-193` — controlla solo se esiste un deny su quell'area (`sameArea`),
**mai** `r.pattern`.

Verificato:
```
evaluate("edit", "/altro/file.txt", perim, [
  { permission: "edit", pattern: "/tmp/altro/*", action: "deny", boundary: true },
  { permission: "edit", pattern: "/altro/*",     action: "allow" },
])
→ deny / edit *      (atteso: allow — il deny copre /tmp/altro, non /altro)
```

Con `buildProjectRuleset` il deny è sempre `*`, quindi oggi non si vede. Ma è
esattamente la stessa fragilità di V8: **confronti per proprietà deboli invece che
per proprietà forti**. Un confine più stretto in futuro ucciderebbe concessioni
legittime, e l'utente non capirebbe perché.

Questo è l'**attrito dall'alto**, complementare a P1 (bypass dall'alto). L'ho
scelto io l'altra volta: filtrare per area senza guardare il pattern.

---

## Difetti reali ma non gravi

### D1. `sameArea` non copre `?`
`sameArea("bash","bash?") = false` (verificato). Con `{bash?, *, allow}` in
`approved`, `isFilterable("bash?")` → `false`, filtro saltato. Servono caratteri
speciali nel *nome* della permission per arrivarci: oggi `fromConfig` non li produce,
ma è lo stesso genere di presupposizione implicita che mi ha già morso.

### D2. Area `write`/`patch` non negata dal perimetro
`buildProjectRuleset` nega solo `edit` e `external_directory`. `FILTERABLE` contiene
`edit` ma non `write`/`patch`/`multiedit`.

**Ma il grep lo smentisce**: `grep -n 'permission: "(edit|write|patch|multiedit)"' src/tool/*.ts`
→ **solo `edit`**, in `write.ts:36`, `apply_patch.ts:177`, `edit.ts:61,93`. Nessun
tool chiede `write`, `patch` o `multiedit`. Le aree non esistono.

→ **Difetto teorico (test vacuo)**: il subagent ha testato aree inesistenti.
L'ho respinto come difetto ma **accettato la lezione**: se un domani esiste un tool
che scrive chiedendo `write`, il perimetro non lo copre. Vale come vincolo per il
`bb hunt` (nuovi tool bounty → nuove aree da negare esplicitamente).

### D3. Nessun avviso all'utente quando la famiglia è revocata
`next.ts:350-356` — quando `voidsBoundary` filtra `ls *` da `always`, c'è solo
`log.info`. L'utente crede di aver concesso la famiglia. È il difetto che avevo
**progettato** (concessione esatta, famiglia non concesso) senza aver progettato la
trasparenza. Reale, e parzialmente mio.

### D4. `bash_unresolved` con `always` vuoto
`bash.ts:284` — con `unresolved.size > 0 && opaque.size === 0` (es. `echo x > $VAR`),
`always` è `[]`: il click "sempre" è un **no-op anche fuori perimetro**. Difetto
funzionale dell'attuale passo, non di sicurezza.

### D5. `presence()` su FIFO blocca il processo per sempre
`bounty-state.ts:192-198` — `lstat` ritorna "present" per una named pipe, poi
`readFileSync` si blocca in attesa di un writer. **DoS completo** del processo.
`lstat` risolve il problema del link rotto ma non questo: `isFIFO()` va escluso da
`presence()`.

### D6. `canonical()` incoerente su path inesistente con symlink intermedio
Se il path completo non esiste, `realpathSync` fallisce **sulla stringa intera** e
il fallback `path.resolve` lascia i symlink intermedi non risolti. Due spelling
diversi della stessa dir non convergono. Difetto minore (nessun buco: dà un falso
negativo, non un falso positivo).

### D7. Fatti storici persi se il symlink nel DB viene rimosso
`canonical` con fallback → la sessione non si collega più alla dir reale, `derive()`
restituisce zero target. Perdita di cronologia, non di sicurezza.

### D8. `isHuntingDir` accetta una dir con nome di soli spazi
`<base>/programs/␣␣␣` → `true`. Cosmetico.

### D9. `regenerate()` senza chiamanti
Se un progetto viene spostato, `read()` lancia `Unreadable` e l'unica via d'uscita è
cancellare `state.json` a mano. Manca un percorso di rigenerazione *su comando*.

### D10. Flag accorpati: `curl -o/tmp/evil`
`project.ts:250-278` — `isPathFlag` confronta `arg === f` in modo stretto, quindi
`-o/tmp/evil`, `--output=/tmp/evil`, `-O/tmp/evil` non estraggono il path. Bypass
dell'estrazione, quindi di `external_directory`.

---

## Ordine di chiusura proposto

1. **G1** (`env`) — una riga, elimina una classe di bypass
2. **G2** (`command_substitution`) — chiude l'elusione più banale
3. **D5** (FIFO) — un `!isFIFO()` in `presence()`
4. **G3** (marcatore) — `boundary` solo da `buildProjectRuleset`; chiude un'arma carica
5. **D10** (flag accorpati) — `-oX`, `--output=X`
6. **G4** (deny stretto) — `boundaryDenies` deve guardare anche il pattern
7. **D3** (trasparenza) — messaggio all'utente quando la famiglia è revocata
8. **D1** (`?` in `sameArea`) · **D4** (`always` vuoto) — attrito, bassa priorità

1–3 sono i soli con impatto di sicurezza **oggi**. Il resto è attrito o robustezza.

## Esiti — applicati in `61639af2a`

**Chiusi** (typecheck 11/11, 935 test, ogni test verificato fallire a difesa spenta):
G1 · G2 · D5 · D10

**D5 ha dato un difetto che il subagent non aveva visto.** Estendendo
`presence()` con il terzo stato `"unreadable"`, `refresh()` confrontava ancora con
`"present"` e quindi cadeva nel ramo "manca del tutto": **rigenerava la FIFO**.
Non era un bug preesistente, era introdotto dalla mia stessa estensione — cioè
esattamente il buco che B1 vieta di riaprire, riaperto dalla difesa. L'ho visto
solo perché il test che ho scritto guardava `lstat` dopo `refresh()` invece di
guardare solo il fatto che lanci. Aggiornato anche `refresh()`.

**Un mio test era sbagliato**, non il codice: ho scritto che `curl -sS
https://x` non deve produrre `https://x` come candidato, ma tutti i posizionali
sono candidati per contratto (`project.ts:106`). Il test è stato riscritto sul
flag (`-sS`), che è ciò che volevo provare davvero.

**Non chiusi, in attesa di decisione:** G3 e G4 — entrambi hanno semantica che
non è univoca, vedi sotto.

---

## La decisione che spetta a te: G4

Ho corretto `voidsBoundary` **tre volte**, in due direzioni opposte:

1. prima versione — filtravo ogni `allow` che coprisse un'area negata, e in
   `evaluate` (fuori perimetro) uccideva 5 test legittimi
2. seconda — ho ristretto il filtro al perimetro, ma per **forma** del ruleset
   (`external_directory` + deny), e mi sono accorto che un confine espresso in
   `ask` non sarebbe stato riconosciuto: tutti i filtri avrebbero saltato in
   silenzio
3. terza — marcatore esplicito `boundary: true`, e l'`allowlist` `FILTERABLE`
   perché l'override `{question: 'allow'}` era ucciso

Ora V9 mi dice che `boundaryDenies` guarda **solo l'area**, mai il pattern:

```
evaluate("edit", "/altro/file.txt", perim, [
  { permission: "edit", pattern: "/tmp/altro/*", action: "deny", boundary: true },
  { permission: "edit", pattern: "/altro/*",     action: "allow" },
])
→ deny    (atteso: allow — il deny copre /tmp/altro, non /altro)
```

Non l'ho toccato. Le due letture possibili sono entrambe legittime e hanno
conseguenze opposte:

**(a) Il confine è l'unica autorità sull'area.** Se nega `edit`, tutte le
concessioni esterne su `edit` sono o ridondanti o pericolose → il comportamento
attuale è corretto. `allow` richieste dall'utente su quell'area semplicemente
non esistono sotto un confine.

**(b) Il confine nega solo dove dice.** Un deny stretto è una scelta, e le
concessioni fuori da quel deny devono valere. Allora `boundaryDenies` deve
guardare `r.pattern`: esiste un deny del confine **che copre questo path**?

Oggi (a) e (b) coincidono, perché `buildProjectRuleset` emette sempre `deny` con
pattern `*`. Divergono appena il confine diventa più stretto — cioè al primo
`bb hunt` che vuole consentire, diciamo, `/tmp` per gli strumenti di scansione.

**Non è una mia decisione**: cambia chi può concedere cosa dentro il perimetro,
e il perimetro è la promessa che l'agente non scrive fuori. Dimmi quale delle
due è quella che vuoi, e il fix è cinque righe.

## Non è un difetto, da segnalare

**E1 resta vero**: `buildProjectRuleset` e `diagnose` non hanno **chiamanti di
produzione**. Tutto questo lavoro è una difesa di libreria, con impatto nullo
finché `bb hunt` non la istanzia. I fix G1/G2/D10 sono sulla classificazione dei
comandi, che è già in uso — quelli sì hanno effetto. I fix al perimetro no.
