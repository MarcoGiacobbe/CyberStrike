# Ticket: identity di disclosure derivata automaticamente dalla policy

## Question

Oggi il campo `identity` di un programma (`h1_username`, `header_name`,
`user_agent_template`) viene **preservato** da `bb sync` ma **mai popolato**:
`bcny.json` ha `identity: null`. La pipeline di iniezione funziona end-to-end
(launcher → worker → Playwright `extraHTTPHeaders` + UA override, applicata
dalla PRIMA richiesta di ogni crawl), ma manca il passo che legge le direttive
del programma e compila l'identity.

Come e dove derivare l'identity dalla policy del programma, nel modo in cui il
programma la chiede (username nel User-Agent, header custom, o entrambi)?

## Context

- Requisito utente (verbatim): *"Header se il programma lo chiede e nel modo in
  cui lo chiede il programma! Da impostare come prima cosa quando si avvia un
  programma e se ne leggono le informazioni!"*
- Codice esistente:
  - `packages/hackbrowser/src/api.ts` — `resolveIdentity(cfg)` legge
    `cfg.identity`, costruisce UA da `user_agent_template` (default
    `CyberStrike-BB/1.0 (H1: {username})`) e `extraHeaders` da `header_name`.
  - `packages/hackbrowser/src/sync.ts:164` — `identity: previous?.identity`
    (conservato, non derivato).
  - `packages/cyberstrike/src/tool/hackbrowser-launcher.ts:52`
    `resolveWorkerIdentity()` — stesso calcolo lato parent.
- Evidenza che il caso d'uso esiste: la policy del programma HackerOne
  (`security`) contiene il blocco *"Required Setup and Identification — Set a
  custom HTTP header in all testing traffic"*. La policy di `bcny` **non**
  chiede identificazione (verificato: zero occorrenze di header/identify) — non
  è quindi un buon caso di test per questa feature.
- Il testo delle policy arriva già dal sync: `bcny.policy.md` (12.702 char,
  sezioni `# Disclosure Policy`, `# Eligibility Requirements`, …) quindi la
  sorgente da cui estrarre è già sul disco.
- Vincolo HARD: nessuna scrittura libera; la derivazione deve avvenire dentro
  `bb sync` / comandi `bb`, con conferma HITL se il valore proposto non è
  univoco.

## Da decidere

1. Estrazione: LLM che legge la policy (già nel contesto del flusso bb) vs
   regex/euristica su frasi chiave ("custom HTTP header", "identify yourself",
   "X-HackerOne-Username")? Il testo delle policy varia molto tra programmi.
2. Default quando il programma NON chiede nulla: nessun header (UA neutro) o
   comunque UA con username? Il requisito utente suggerisce "solo se lo chiede".
3. Scrittura: `bb sync` propone e chiede conferma, o scrive direttamente nel
   program JSON + riporta cosa ha scritto? Il vincolo HITL vale per programma
   nuovo o anche per l'aggiornamento dell'identity?
4. Override manuale: come convivono identity derivata e identity scritta a mano
   dall'utente (chi vince su un successivo `bb sync`)? Serve un flag
   `identity.source: "derived" | "manual"` per non sovrascrivere scelte umane.
5. Verifica: come si prova che l'header è davvero partito — serve un test E2E
   che ispezioni le request del worker su un target proprio (bbtest / app di
   test su :4545), non su un target terzo.

## Nota di stato (2026-09-24)

Nessuna implementazione iniziata. La funzione `resolveIdentity()` è pronta e
verificata; manca unicamente il popolamento di `cfg.identity` a monte. Il
ticket #6 della mappa ("H1 token") è di fatto risolto: l'identifier dell'API è
lo username H1 (`markjacob9`), non il valore del token.