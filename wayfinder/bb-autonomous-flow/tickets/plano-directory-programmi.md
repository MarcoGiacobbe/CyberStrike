# Piano: la directory del programma è il progetto (2026-09-29)

## Il problema

`bb hunt <programma>` oggi passa al TUI la sessione e il messaggio iniziale ma
**non la directory del programma** (`bb.ts:791`):

```ts
const tuiArgs = ["--session", session.id, "--prompt", message, "--agent", args.agent]
```

Il TUI fa `process.chdir(args.project ? ... : process.cwd())` (`tui/thread.ts:95`),
quindi parte dalla directory da cui l'utente ha lanciato il comando. Tutto quello
che il meccanismo `AGENTS.md` risolve in base a `Instance.directory` non gira sulla
directory giusta: l'agente riceve le istruzioni del terminale da cui e' partito, non
quelle del programma.

Il perimetro software NON e' compromesso: usa la directory registrata nella
sessione, non il `cwd`. Il difetto e' sulle istruzioni.

## Le 4 decisioni approvate (Marco, 2026-09-29)

1. **Sync automatico**: si, a ogni `bb hunt`, ma solo se i dati hanno piu' di 24 ore.
   `--force` per forzarlo.
2. **Se il sync fallisce la caccia parte**: si', con avviso esplicito. Non si blocca
   perche' la rete e' giu' — si lavora con quello che c'e', dichiarandolo.
3. **I file li genera `bb sync`**, non `bb hunt`. `bb hunt` segnala solo se mancano.
4. **Se un file esiste gia' e il sync ne genererebbe uno diverso**: riscrivere.
   Scope vecchio in un report e' piu' pericoloso di una sovrascrittura.

## La forma dei file, nella directory del programma

Tre file `.md`, non uno. Un file unico da 12 KB non viene letto; i file con un
nome chiaro vengono aperti.

| File | Contenuto | Chi lo legge |
|---|---|---|
| `AGENTS.md` | corto: chi sei, su cosa stai lavorando, cosa non toccare MAI, il tetto di richieste, i rimandi agli altri due | **automatico**, entra nel prompt di sistema a ogni sessione (`src/session/instruction.ts:71-116`) |
| `scope.md` | target in scope, out of scope, **separati per URL vs non-URL**, payout per asset in tabella | su rinvio dell'AGENTS.md |
| `policy.md` | testo integrale del programma, mai troncato (oggi: 500 char + "…", che taglia a meta parola) | su rinvio dell'AGENTS.md |

`AGENTS.md` non finisce nel messaggio iniziale: gia' e' istruzioni di sistema,
per la sua stessa natura. Il messaggio iniziale tiene i dati che CAMBIANO (fase,
target toccati, finding) e rimanda.

## Perche' tre file e non uno

`bcny.json` contiene 12 asset in scope di cui 5 non sono URL (`Dia Assistant`,
`Arc on Mac`, `id6472513080`). Oggi finiscono in una lista di indirizzi e un agente
li legge come target web. La sezione separata e' il punto 1 approvato.

I payout per-asset (`Dia on MacOS $20,000 crit`) stanno oggi dentro una stringa
sola, `rules.custom[3]`. Sono la parte piu' utile del programma: dicono dove
conviene andare. In tabella diventano usabili.

## Fasi

### Fase 1 — la directory (il difetto vero)
- `bb.ts`: passare `--project <directory>` nei `tuiArgs`.
- Verifica: `Instance.directory` == directory del programma dentro la sessione.
- Test: il TUI riceve la directory del programma, non il cwd.

### Fase 2 — i tre file
- Nuovo modulo: rendering di `AGENTS.md`, `scope.md`, `policy.md` dal config.
- Chiamato da `bb sync` (decisione 3). Idempotente: stessi dati -> stesso file.
- `scope.md` separa URL da non-URL. `policy.md` prende il testo integrale, non i
  500 char di `rules.custom`.

### Fase 3 — sync automatico
- `bb hunt` chiama `syncProgram` se `lastUpdated` ha piu' di 24h. `--force` scavalca.
- Se il sync fallisce: warning esplicito con l'eta' dei dati, la caccia parte.
- `--dry-run` resta senza effetti: niente rete, niente scrittura.

### Fase 4 — il messaggio iniziale
- Piattaforma e URL (esistono gia' nel config, non stampati: `bugbounty.ts:19-21`).
- Rimando esplicito ad `AGENTS.md`, `scope.md`, `policy.md` con la regola scritta,
  non la promessa.
- Dati assenti: si dichiara solo se l'assenza e' un ostacolo (regola approvata).
  "known issues non disponibili" NON va in ogni avvio: non e' un ostacolo.

## Cosa NON cambia

- Il perimetro software e la sandbox: gia' misurati (V14/V16/V17), non li tocco.
- `bb sync` resta lanciabile a mano, identico.
- I 4 programmi gia' sincronizzati non vengono toccati senza un sync esplicito.

## Ordine e regole

- Una fase alla volta, con test e controprova a `HEAD` prima di chiudere.
- `export PATH="$HOME/.local/share/bun-1.3.9/bin:$PATH"` a ogni comando (il bun di
  sistema e' 1.4.2 e produce falsi fallimenti e TUI che non disegna).
- Nessun container senza `free -g` sopra 2 GB, e chiusura esplicita a fine test.
- typecheck `bun turbo typecheck` (11/11) e suite completa prima di ogni commit.

## Domande aperte

- `identity-da-policy` resta aperto: `AGENTS.md` puo' gia' dichiarare che l'header
  richiesto non e' stato derivato, ma il popolamento automatico no.
- `credenziali-h1-sync` resta aperto: `bb sync` usa il GraphQL pubblico, non le
  credenziali. Se passa a usarle, cambia il piano della fase 3 (sync piu' utile).
