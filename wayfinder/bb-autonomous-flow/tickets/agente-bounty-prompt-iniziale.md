# Ticket: agente bounty + messaggio iniziale di sessione

## Stato: FASE 1 IMPLEMENTATA E MISURATA (2026-09-29)

## Ritrovamento che cambia la fase 3 (2026-09-29)

**Il file `policy.md` completo esiste GIA' su disco.** `bb sync` lo scrive:
`sync.ts:176` → `writeFileSync(\`${dir}/${handle}.policy.md\`, policy)`.

Misurato sulla macchina dell'utente:
```
bcny.policy.md        12.702 byte
bookingcom.policy.md  12.966 byte
security.policy.md     7.226 byte
```

Conclusione: la fase 3 NON deve generare il file. Deve **indirizzarlo** —
il messaggio iniziale e l'`AGENTS.md` dicono all'agente che il testo
integrale della policy è quel file, invece dei 500 caratteri troncati. Il
lavoro reale della fase 3 è `scope.md` + payout per-asset + il collegamento.

## Difetto: `bb hunt` su programma inesistente lanciava il TUI (2026-10-01)

Segnalato dall'utente. Prima lanciava l'interfaccia da ~800 MB su uno scope
fantasma e restava appeso; in una riga di terminale il comando usciva dopo
200+ secondi con un processo vivo.

### Rete assente e programma inesistente non sono la stessa cosa

La Fase 2 aveva deciso che un sync fallito non blocca l'avvio. Bene, ma quel
comportamento nascondeva un caso diverso:

- **rete assente** — si risolve riprovando piu' tardi, e l'utente ha gia' i
  dati buoni: si parte e si dichiara;
- **programma inesistente** — non si risolve affatto. Se il nome e' sbagliato
  o il programma e' stato chiuso, l'agente produce finding su target che non
  esistono e l'utente lo scopre quando il report viene respinto.

Il secondo e' un errore di input, non un fallback.

### Perche' l'errore e' tipizzato e non cercato nel testo

Lo stesso fatto arriva da due punti con due testi diversi:

- `sync.ts:103`, quando `team` e' null -> `Program 'x' not found on HackerOne`
- GraphQL, quando il team non c'e' -> `Team does not exist`

Grappolarsi sul testo significa che un refactor del messaggio upstream
rimette in gioco il TUI su un programma inesistente. La decisione si prende in
`sync.ts`, dove si sa che il team e' assente, e viaggia come
`ProgramNotFoundError`.

Il default di `isProgramMissing` e' **falso**: scambiando un errore di rete
per "inesistente" si fa fallire un avvio che poteva partire, e quello e' un
danno minore che far partire un agente su scope fantasma.

### Il mio primo fix NON funzionava, e il difetto non era dove credevo

Avevo scritto `isProgramMissing(e) && unsynced`, per non fermarmi se il file
del programma esisteva gia' in locale. Ho misurato che il TUI partiva
ugualmente: esattamente il difetto segnalato. La tolleranza non serviva a
niente — se HackerOne non conferma piu' il programma, l'agente lavorerebbe su
uno scope morto. Tolta.

Vale la pena registrarla perche' mostra dove NON era il difetto: la
classificazione dell'errore era giusta al primo colpo. Il buco era la
condizione con cui veniva usata, e quel buco non si vede nei test sulle
funzioni pure.

### Misurato

```
prima:   200+ s, TUI lanciato, ~800 MB, processo appeso
dopo:    4 s, exit 1, nessun TUI
```

```
✗ il programma "nonesiste" non esiste su HackerOne.
  Niente e' stato scritto. Controlla il nome e riprova.
  Programmi in locale: nonesiste
```

L'elenco dei programmi in locale c'e' perche' un refuso e' molto piu'
probabile di un programma cancellato, e mostrarre gli handle validi risolve il
problema senza dover chiedere.

### Il caso opposto verificato davvero, non ragionato

Bloccando la rete con un proxy verso una porta chiusa:

```
🔄 Aggiorno i dati di bcny…
> ⚠ non ho potuto aggiornare i dati di bcny: Unable to connect. Is the computer able to access the url?
> uso quelli dell'ultimo salvataggio — 30 giorni fa.
```

exit 0: la Fase 2 continua a funzionare. Il fix non ha mangiato il fallback.

### Test: 3 end-to-end + 4 sulle funzioni

`test/cli/bb-hunt-missing-program.test.ts` misura uscita e **tempo**, non
una stringa interna. Un test sulle funzioni pure sarebbe restato verde per
tutta la fase mentre il difetto vero era vivo.

```
col fix:                     3 pass, 0 fail
condizione && unsynced:     2 pass, 1 fail
typecheck:                   11/11
```

Dichiarati **non-regressione**: "la rete assente continua a partire col
fallback" e i 4 test di `bb-errors.test.ts` sulle funzioni di pure
classificazione.

**Limite dichiarato**: il test sul tempo ("non ci mette minuti") resta verde
anche con la condizione sbagliata, perche' misura la durata e non l'esito —
il TUI lanciato risponde in qualche secondo. Misura il pegno, non il difetto:
e' il test sull'esito che tiene.

### Pulizia

Tre prove manuali hanno lasciato un TUI appeso e tre directory in /tmp, perche'
il fix non funzionava. Chiusi a mano: 0 processi, 0 tmp, 0 container.
Verificato anche che i dati reali (`bcny`, 6 giorni, 13 target) fossero
intatti: le prove usavano `CYBERSTRIKE_HOME` temporaneo.

## Fase 3 — fatta e controprovata (2026-09-30)

Nella directory di ogni programma ora ci sono `AGENTS.md` (l'indice, 750 byte)
e `scope.md` (lo scope, 757 byte). Entrambi riscritti a ogni `bb hunt`.

### La scelta: due file, non tre

`AGENTS.md` e' l'indice e dice dove trovare il resto. `scope.md` e' lo scope.
La **policy integrale non viene rigenerata**: `bb sync` la scrive gia' in
`~/.cyberstrike/bugbounty/<handle>.policy.md` (12.719 byte per bcny) e copiarla
qui aprirebbe due fonti che divergono. Il compito e' il rimando, non la copia.

Il rimando e' un percorso ASSOLUTO, perche' la directory del programma e'
`.../bugbounty/programs/<handle>/` e la policy sta due livelli sopra.

### La classificazione che mancava: URL e non-URL

`bcny` ha 13 asset in scope e NON sono tutti siti. Mescolati in una lista
unica, un agente che legge `Arc on Mac` accanto ad `arc.net` puo' tentare di
visitare `arc.net` per il bounty di Arc on Mac — che e' un'app desktop da
$20,000, e cosi' spende i suoi passi sul target sbagliato.

`scope.md` li separa:

```
## Siti web in scope
- arc.net
- thebrowser.company
- bcny.com
- diabrowser.com
- company.thebrowser.arc

## Prodotti in scope (non sono siti web)
Non aprire questi come pagine web: sono app o prodotti.
- Dia Assistant
- Arc on Mac
- ...

## In scope, da chiarire con l'utente
- id6472513080 (non e' un sito ne' un prodotto: chiedi prima)
```

`id6472513080` e' un id numerico: non ha un punto, quindi non e' un dominio,
e non ha spazi, quindi non e' un prodotto. Va in una terza sezione esplicita
invece di sparire: un asset che sparisce e' un asset che l'agente ignora in
silenzio, che e' peggio di uno che chiede.

### Difetto trovato e corretto: il rimando era rotto

Prima versione: `AGENTS.md` scriveva "la policy NON e' in locale: lanciare
`bb sync`". Il file esisteva. Causa: passavo `programsRoot`
(`.../bugbounty/programs`) come directory della policy, che sta invece nella
root di `bugbounty`. Un rimando rotto e' peggio di nessun rimando: l'agente
chiede all'utente una sync che non serve.

Corretto e coperto da un test dedicato, la cui controprova ho eseguito
rimettendo il path sbagliato: **7 pass, 1 fail** solo su quel test.

### Difetto trovato: `--dry-run` non mostrava nulla

Il test del cablaggio e' rosso perche' in `--dry-run` la directory non
esisteva (la creazione dello stato e' saltata, essendo `!args.dryRun`) e la
scrittura falliva con `ENOENT`. Il mio codice lo dichiarava da solo a
terminale: "non ho potuto scrivere i documenti". Aggiunta la `mkdir`.

Ironico: il comando che serve a ispezionare senza lanciare il TUI da 800MB
era proprio quello che non ispezionava.

### Test: 8 nuovi

```
col fix:                    8 pass, 0 fail
bb.ts a HEAD:               6 pass, 1 fail  (solo il cablaggio)
path sbagliato rimesso:     7 pass, 1 fail  (solo la regressione del rimando)
typecheck:                  11/11
```

Due controprove distinte, perche' i due difetti sono due difetti: uno nel
cablaggio, uno nel percorso. Un test solo avrebbe coperto il primo e lasciato
il secondo verde.

### Pulizia

Rimossa `~/.cyberstrike/bugbounty/programs/bcny/program/`, directory VUOTA
lasciata il 26 settembre dalla vecchia `mkdir`. Verificato che fosse vuota
prima di rimuoverla.

## Fase 2 — fatta e controprovata (2026-09-29)

`bb hunt` sincronizza da solo se i dati hanno piu' di 24 ore; `--force` forza.
`bb sync` manuale resta intatto.

### La scelta, e perche' non a ogni avvio

Non e' "sync a ogni `bb hunt`", e' "sync se i dati hanno piu' di 24 ore".
Motivi, perche' la decisione va scritta accanto al codice:

- il TUI e' un processo da ~800 MB: l'avvio costa piu' del sync;
- `bb hunt` su un programma gia' fresco **non deve dipendere dalla rete**:
  se la rete e' assente l'avvio deve funzionare lo stesso, perche' i dati
  che ci sono bastano a partire;
- `--force` aggiorna quando serve.

E' la regola che si ha gia' davanti con npm, docker o un pacchetto pip.

### Comportamento misurato (non ipotizzato)

Tre regole, verificate col CLI reale:

1. **`--dry-run` non sincronizza.** Verificato su `bcny` (dati di 6 giorni):
   stampa `(--dry-run: sincronizzerei bcny — dati di 6 giorni fa)` e non
   scrive. Il config resta identico.
2. **Il sync fallito non blocca l'avvio.** Misurato lanciando `bb hunt` su un
   programma inesistente con scope vecchio di 30 giorni: il sync e' partito
   ed e' fallito con `HackerOne GraphQL: Team does not exist`, l'avvio ha
   continuato, la sessione e' stata creata e il TUI lanciato con lo scope
   VECCHIO. Nessun exit 1.
3. **L'avviso va NEL PROMPT dell'agente, non solo a terminale.** Sta prima di
   `## Scope IN`, perche' se l'agente legge prima lo scope e poi l'avviso
   l'avviso non serve. Motivo: un report prodotto su scope invecchiato viene
   respinto, quindi e' l'agente — non l'utente — la prima cosa che deve
   sapere che quei dati non sono freschi.

Testo che arriva all'agente:
```
> ⚠ non ho potuto aggiornare i dati di nonesiste: HackerOne GraphQL: Team does not exist
> uso quelli dell'ultimo salvataggio — 30 giorni fa. Non fidarti dello scope: prima di toccare un
  target, digli all'utente di lanciare `bb sync nonesiste`.
```

### Test: 9 nuovi, controprova eseguita

`test/cli/bb-hunt-sync.test.ts`

```
col fix:                    9 pass, 0 fail
bb.ts a HEAD:               7 pass, 2 fail
typecheck:                  11/11
suite:                      1831 pass, 1 fail preesistente (xai/grok-3)
```

La controprova e' instructiva e vale la pena leggerla: a HEAD i test delle
**funzioni pure** (`needsSync`, `ageHours`) restano VERDI, e si rossa solo il
test che verifica il **cablaggio**. Questo conferma il limite dichiarato:
quelli testano la logica, non che `bb hunt` la chiami. Il test del cablaggio
(`il sync e' CABLATO`) e' quello che misura la fase.

**Dichiarati non-regressione** (verdi a HEAD, non provano un difetto):
- "col programma gia' fresco non riscrive il config"
- "`bb sync` manuale resta funzionante"

### Errori miei durante la fase, dichiarati

- Il test del cablaggio confrontava due timestamp assoluti calcolati in
  due istanti diversi: rosso per i millisecondi, non per il difetto.
  Ora confronta l'eta' in giorni.
- Quando ho provato `bb hunt` SENZA `--dry-run` per verificare il fallback,
  il comando e' andato in timeout e ha **lasciato un TUI appeso** (~800 MB).
  Chiuso con SIGKILL; verificato: 0 processi, 0 tmp, 0 container. La prova
  del fallback l'ho ricavata leggendo gli argomenti reali del processo da
  `/proc`, non ricostruendoli a memoria.

### Nota su `ageHours`

Un `lastUpdated` nel FUTURO restituisce `Infinity`, non 0: e' un dato corrotto,
e trattarlo come "freschissimo" farebbe partire l'agente senza sincronizzare
per anni. `lastUpdated` assente o illeggibile restituisce `null` = da
sincronizzare, non "fresco".

## Fase 1 — fatta e controprovata (2026-09-29)

Tre difetti, tutti misurati a `HEAD` prima del fix:

1. **`bb hunt` non passava la directory del programma al TUI.**
   `bb.ts:791` costruiva `tuiArgs` senza `--project`. Il TUI fa
   `process.chdir(args.project ? resolve(...) : process.cwd())`
   (`tui/thread.ts:95`), quindi l'agente partiva dalla cartella del terminale
   e `AGENTS.md` veniva risolto sul posto sbagliato: l'agente riceveva le
   istruzioni del progetto da cui l'utente aveva lanciato il comando.
   FIX: `--project <directory del programma>` nei tuiArgs.

2. **Il messaggio all'agente prometteva un `program.json` che non esiste.**
   `hunt-context.ts` diceva "Non c'e' un `program.json`: lo scope e le regole
   qui sotto non ci sono". `program.json` non compare in nessun punto di
   `src/`: il file reale e' `<handle>.json` nella root bug bounty
   (`bb.ts:664-671`). Il messaggio negava dati che l'agente aveva sotto gli
   occhi e promise un file inesistente.
   FIX: riscritto — dice che i dati non sono in disco e che cosa fare.

3. **Una directory vuota creata a ogni avvio.** `bb.ts:693` faceva
   `mkdirSync(path.join(directory, "program"))`. Unica occorrenza di quel
   nome in tutto `src/`: la riga stessa. Nessuno la leggeva.
   FIX: rimossa.

### Test e controprova

`test/cli/bb-hunt-directory.test.ts`, 4 test.

```
col fix:   4 pass, 0 fail
a HEAD:    2 pass, 2 fail   (i due difetti reali)
typecheck: 11/11
```

**Due test sono dichiarati non-regressione** e non provano i difetti:
- "il TUI accetta un argomento di progetto": a `HEAD` e' gia' verde, il flag
  esisteva gia' nel TUI. Serve a impedire che il fix passi un flag inventato.
- "la directory creata non contiene `program`": il dry-run gia' evitava la
  mkdir. Dice cosa non deve ricomparire, non che il difetto fosse riprodotto.

### Due errori miei durante il lavoro, dichiarati

- Il test ispezionava il sorgente con una regex; l'apostrofo di `e'` nei
  commenti italiani la faceva agganciare. Riscritto per **chiamare**
  `HuntContext.message()`: si misura il testo che l'agente riceve davvero.
- La finestra di 8 righe attorno a `tuiArgs` si fermava a `--agent` e non
  arrivava a `--project`: il test era rosso **col fix gia' applicato**, cioe'
  misurava la mia ipotesi sulla formattazione. Ora legge l'array intero.

### Difetto scoperto, NON ancora chiuso

`test/tool/bounty-state-initialization.test.ts:34-37` costruisce a mano
`program/program.json`, cioe' lo stesso file che non esiste in produzione. Il
test passa ma la sua premessa e' falsa: e' un test che non descrive il
comportamento reale. Da riscrivere quando si affronta lo stato.

## Storico del difetto (rimosso: era STALE)

Il ticket originale lamentava che il messaggio iniziale non mostrasse
piattaforma, URL del programma e regole custom. Quei dati **esistono gia'**
in `sync.ts` e in `HuntContext.message`. Cio' che manca davvero e' altro, e
e' quello scritto sopra.

## Question

Definire l'agente dedicato all'hunting su programma (toolset + prompt) e il
messaggio con cui `bb hunt` apre la sessione: quali informazioni del programma
ci finiscono, in che forma, e con quali placeholder ancora aperti.

Attenzione: NON va inventato un agente da zero — il toolset per l'hunting web
esiste già ed è cablato.

## Context — cosa esiste già

Agenti esistenti (`src/agent/agent.ts`):
- `web-application` — descrizione: *"Web application security specialist. OWASP
  Top 10, WSTG methodology, API security testing."* mode `subagent`, skills
  `wstg-recon-config`, `wstg-auth-session`, `wstg-injection`, `wstg-logic-client-api`,
  permessi: `bash`, `hackbrowser`, `read`, `glob`, `grep`, `webfetch`, `websearch`,
  `report_vulnerability`, `triage_vulnerability`, `add_intel`, `update_vrt_check`,
  `methodology_status`, `scope_check`, `ensure_tools`, `attack_script` (tutti allow)
- altri: `cloud-security`, `internal-network`, `mobile-application`,
  `normalize-request`, `proxy-agent`, `proxy-tester-*` (idor/authz/injection/…)

Tool di reportistica già presenti: `generate-report`, `triage-vulnerability`,
`vrt-check`, `scope-check`, `report_vulnerability`, `methodology-status`.

Prompt: `src/agent/prompt/methodology/common-prompt.txt` + `web-application.txt`;
overlay bug bounty in `packages/hackbrowser/src/prompt/bugbounty.txt` (15.624
byte) — oggi caricato dal NAVIGATOR (`navigator.ts:16`), non iniettato nella
sessione dell'agente.

Placeholder dinamici già previsti (restano placeholder finché il fetch non li
popola): `{program_name}`, `{platform}`, `{scope_in}`, `{scope_out}`,
`{known_issues}`, `{payout_focus}`.

## Contenuto atteso del messaggio iniziale

- nome programma, piattaforma, URL
- scope in / scope out (con nota sul limite: `bb sync` prende max 100 asset,
  niente paginazione; wildcard non convertiti in pattern)
- payout (per tier + per asset)
- regole + esclusioni (`EXCLUSION <categoria>: …` da `declarative_policy`)
- **header/identità richiesti dal programma** — dipende da
  [identity-da-policy]: se non implementato, il messaggio deve dirlo
  esplicitamente invece di tacere
- known issues: **oggi NON disponibili** (la query GraphQL non le chiede) →
  il messaggio non deve fingere di averle
- fase corrente + cosa resta (da [stato-progetto])
- toolset disponibile e vincolo di scrittura

## Da decidere

1. Agente nuovo `bounty` che estende `web-application`, o riuso diretto di
   `web-application` con prompt iniettato per sessione? (il primo è più pulito
   ma duplica; il secondo non permette un prompt diverso per agente)
2. Prompt: `bugbounty.txt` va iniettato come messaggio utente iniziale, come
   system prompt dell'agente, o entrambi? Oggi il file esiste ma arriva solo al
   navigator.
3. Formato del messaggio: markdown compatto vs JSON strutturato — dipende da
   quanto il modello deve "leggere" vs "usare" i dati
4. Chi fa il rendering dei placeholder, e cosa succede se un dato manca
   (sezione omessa vs stringa "unknown")? Silenzio vs dichiarazione esplicita.
5. Il messaggio deve essere visibile all'utente nella TUI (trasparenza su cosa
   è stato detto all'agente) o è contesto nascosto?