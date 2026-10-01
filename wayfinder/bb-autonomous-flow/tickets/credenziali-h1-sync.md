# Ticket: Credenziali API HackerOne per il sync (HITL)

## Stato: IMPLEMENTATO — 2026-10-01, con due correzioni emerse verificando sul reale

## Question

Il fetch automatico (bb sync) richiede un API token HackerOne dell'utente.
Generarlo è manuale (hackerone.com → Settings → API Tokens). L'utente deve
crearne uno e passarlo — dove? `bb connect --api-identifier/--api-token`
già esiste (salva in credentials.json chmod 600).

## Cosa misurato davvero (2026-10-01)

Il presupposto del ticket era che il token servisse a "scaricare scope/policy
reali". Misurato, è diverso in tre punti:

1. **Il token NON puo' sostituire la chiamata anonima.** L'endpoint che
   `bb sync` usa oggi (`hackerone.com/graphql`) risponde `401 Invalid
   authentication token` se riceve il token API. I due endpoint non si
   parlano: GraphQL del sito = anonimo; REST `api.hackerone.com/v1/hackers/*`
   = autenticato.

2. **Lo scope privato NON esiste per un cacciatore.** Con il token,
   `/v1/hackers/programs/<id>/structured_scopes` risponde `404 Team does not
   exist` — non "vietato", inesistente. Su un campione di 25 programmi
   visibili col token, nessuno era privato. Quindi **non c'è da "gestire il
   privato"**: non è una nostra lacuna, è un limite dell'API. Lo scope resta
   anonimo, e resta la sua unica fonte.

3. **La REST è paginata e l'ordine non è stabile.** Con il token si ottengono
   595 programmi in 6 pagine; `bcny` è in pagina 6 (non in pagina 1). Una
   singola richiesta avrebbe fatto fallire la policy per la maggior parte dei
   programmi. Dettaglio scoperto verificando sul reale, non sui test.

Cosa il token dà, in concreto: **la lista dei programmi che l'utente può
vedere** e una **copia della policy via REST che non tronca**. Attenzione:
su `bcny` le due fonti danno entrambe 12.702 caratteri, cioè sul programma
reale il vantaggio del token sulla lunghezza è **zero**. Il vantaggio è che
la REST esiste e non tronca, non che oggi dia più byte.

## Decisione implementata

Due fonti complementari, non una chiamata "con o senza token":

- **scope**: anonimo GraphQL, invariato byte per byte. Unica fonte possibile.
- **con token**: in più la policy (preferendo la più lunga delle due) e
  l'elenco dei programmi visibili.

Senza token il comportamento è **identico a HEAD**: verificato per confronto.
Ogni errore della fonte col token è non fatale per scelta — un token scaduto
non deve far perdere una sincronizzazione che l'anonimo sa fare da solo.

## Difetti trovati e corretti durante l'implementazione

- **Elenco programmi vuoto su token rifiutato.** Un 401/403 restituiva
  l'elenco parziale come se fosse una risposta valida: `[]` si leggeva come
  "questo utente non vede programmi", che è falso. Ora 401/403 → elenco
  assente, e un flag `tokenRejected` lo distingue da "ho guardato, non vedo
  niente".
- **Paginazione mancante.** Prima della correzione la policy col token
  arrivava solo per i programmi in pagina 1 (misurato: solo 1 pagina letta,
  `bcny` perso).
- **Elenco programmi troncato** (trovato dalla verifica indipendente
  `deleg_37df8766`, non da me). Il ciclo di paginazione si fermava appena
  trovata la policy del programma richiesto (`&& !policy`), quindi la lista
  restava troncata alla pagina che lo conteneva: **100 handle su 595** nel
  caso reale, 2 su 3 nel finto. Nessun errore, nessun avviso: un elenco
  presentato come completo ma non lo e'. Corretto scorrendo tutte le pagine,
  con `policy ??=` perche' le pagine successive hanno la policy vuota e
  sovrascrivevano quella appena trovata.

## Test

`packages/hackbrowser/test/sync-token.test.ts`, **6 test**. Controprovi:
togliendo l'aggancio della fonte col token cadono 2 test; ripristinando il
ciclo che si ferma alla prima pagina cade il test dell'elenco completo.

**Due falsi verdi trovati e corretti nei test stessi**, entrambi da controprova:
- il finto server restituiva la policy già per intero, quindi il test della
  policy passava anche senza la fonte col token;
- il finto accettava qualunque token, quindi "token rotto" era indistinguibile
  da "token valido" e il test del fallback non misurava nulla.

Entrambi i difetti dei fake sono oggi coperti da test (anonimo troncato a 500
come il reale; 401 se il token non è quello buono).

## Azione

- [x] Utente: genera API token su HackerOne (Settings → API Tokens)
- [x] Utente: `bb connect --api-identifier <id> --api-token <token>`
- [x] Verifica E2E su reale: `bcny` → 13 asset in scope, 595 programmi
      visibili, policy 12.702 caratteri, nessun token in alcun file scritto

## Residuo noto (fuori scope, misurato)

Il token salvato restituisce anche `401` su `/v1/hackers/reports`: vale per
leggere programmi e policy, **non per inviare o leggere report**. Per la
segnalazione servirà un token di tipo diverso. L'utente ha deciso di
rimandare.
