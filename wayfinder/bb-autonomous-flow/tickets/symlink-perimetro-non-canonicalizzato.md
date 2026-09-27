# Symlink: il controllo del perimetro non canonicalizza il path

**Aperto 2026-09-27. Non ancora testato a runtime — questa e' un'analisi del
codice, non una riproduzione.**

## Il sospetto

`assertExternalDirectory` confronta il path richiesto con il perimetro **senza
risolverlo**:

```
packages/cyberstrike/src/tool/external-directory.ts:17
  -> Instance.containsPath(...)      filesystem.ts:35-36
```

`containsPath` lavora sulla stringa del path. Se dentro
`programs/bcny/` c'e' un symlink `fuori -> /etc`, e l'agente scrive su
`programs/bcny/fuori/pasd`, il path richiesto e'`programs/bcny/fuori/pasd`:
contenuto, perimetro rispettato, autorizzazione concessa. La scrittura pero'
segue il link e finisce in `/etc/pasd`.

`apply_patch` normalizza i `..` con `path.resolve` (`apply_patch.ts:61`) ma
`path.resolve` non segue i symlink. Stessa cosa.

## Perche' conta piu' di quanto sembri

Con `BB_ROOT` montata `rw` (vedi [fuga-laterale-fra-programmi.md](fuga-laterale-fra-programmi.md)),
l'agente puo' **crearsi da solo il symlink**: non deve trovarlo gia' pronto.
Basta un symlink dentro la propria directory di programma che punta a
`../..`, e da lì il perimetro non ferma piu' niente.

E' il buco che trasforma "l'agente puo' scrivere dove deve" in "l'agente puo'
scrivere ovunque", senza bisogno di altre tecniche.

## Cosa NON e' stato verificato

Non ho riprodotto la fuga. Il ragionamento e' basato sulla lettura del codice e
potrebbe essere sbagliato su un dettaglio (per esempio `containsPath` potrebbe
gia' canonicalizzare piu' in basso nella catena, o `Bun.write` potrebbe
rifiutare di seguire il link). Va detto chiaramente: **questa e' un'ipotesi, non
un difetto confermato.**

## Test da fare, con il controllo positivo

Il test DEVE avere una scrittura di controllo dentro il perimetro. Senza, un
tool che non scrive nulla passa per sicuro, ed e' esattamente l'errore che ha
falsato la prima verifica V11.

1. **controllo positivo**: `write` su `programs/bcny/prova.txt` -> deve
   riuscire, file presente
2. **creazione del symlink**: l'agente crea `programs/bcny/fuori` ->
   `/etc` (dentro il perimetro, quindi autorizzata)
3. **attacco**: `write` su `programs/bcny/fuori/prova.txt`
4. **verifica dall'host**: `/etc/prova.txt` nel container deve essere ASSENTE
5. **distinguere gli esiti**: `deny` del perimetro e' il risultato atteso;
   `EACCES` e' un blocco del sistema, non del perimetro; `ask` e' peggio — e'
   un'operazione consentita che aspetta una decisione

Se `deny` non arriva e il file viene creato, il difetto e' confermato e la
priorita' sale sopra la fuga laterale.

## Criterio di chiusura

- [ ] il controllo positivo scrive dentro il perimetro (test valido)
- [ ] il symlink viene negato dal perimetro, o il path viene canonicalizzato
        prima del confronto
- [ ] nessuna forma di TOCTOU: non basta controllare e poi scrivere, se il
      controllo e la scrittura sono separati nel tempo (`write.ts:27`,
      `edit.ts:45`, `apply_patch.ts:62`)

## Verifica `deleg_5b020b7c` (2026-09-27) — CONFERMATO, con una pecca nel test

Il difetto **e' reale**: il perimetro autorizza percorsi che sembrano dentro
`bcny` ma scrivono in `programs/bcny-test`, che e' un programma diverso.
`external-directory.ts:17` confronta il path lessicale, che resta sotto `bcny`
anche quando un componente e' un symlink.

### Prove (tutte con controllo positivo, verificato dall'host)

| prova | esito CyberStrike | verifica dall'host |
|---|---|---|
| controllo positivo `write` in `bcny` | `edit allow`, scritto | file presente in `bcny` |
| `write` via symlink `bcny/link -> bcny-test` | `edit allow` | **file in `bcny-test`**, fuori perimetro |
| `edit` via symlink | `edit allow` | **file in `bcny-test`**, fuori perimetro |
| `apply_patch` via symlink | `edit allow` | **file in `bcny-test`**, fuori perimetro |

Tutti e tre i tool che scrivono sono affetti, non solo `write`.

### I due limiti della prova, da non dimenticare

1. **Il symlink era una fixture preparata dal test**, non creato dall'agente. Con
   `BB_ROOT` montata `rw` l'agente *potrebbe* crearselo da solo, e allora la
   fuga diventa utilizzabile senza preparazione. Non e' dimostrato: e' il punto
   che V13 (`verify-v13-symlink.sh`) deve stabilire.
2. **Non era una sessione live `bb hunt`**: le implementazioni reali dei tool
   sono state esercitate con il ruleset reale, ma non il percorso completo
   `prompt -> tool -> gate -> filesystem` di una sessione pilotata dal modello.

Su `/etc` l'esito e' stato `edit allow` seguito da `EACCES`: il perimetro ha
autorizzato, e ha bloccato il sistema operativo. Questo **conferma che il
perimetro non copre la destinazione reale**. Il tentativo di creare il symlink
verso `/etc` con bash e' stato negato (`external_directory deny /etc/*`).

## Percorsi dinamici: `ask` NON e' una fuga (2026-09-27)

Le tre forme sono risultate `ask`, non `deny`:
`$HOME/prova`, `$(echo /etc/prova)`, `bash -c '...'`. Nessuna ha scritto, e
questo e' corretto per costruzione: `PermissionNext.ask` (`permission/next.ts:305-320`)
restituisce una `Promise` che si risolve **solo** con una risposta umana. Senza
risposta la Promise resta pendente e il tool non parte. `bb hunt` non ha un
auto-approve (`cli/cmd/bb.ts` non chiama `PermissionNext.reply`).

Quindi in un flusso non presidiato un `ask` **blocca**, e blocca dal lato
sicuro. Il rischio residuo non e' la fuga immediata, e' la promessa pendente:
una sessione autonoma che chiede conferma e non la riceve resta ferma. Va
deciso se in modalita' autonoma `bash`/`bash_unresolved` debbano essere `deny`.

## Criterio di chiusura

- [x] il controllo positivo scrive dentro il perimetro (test valido)
- [x] il symlink viene autorizzato dal perimetro: difetto **confermato**
- [ ] V13: l'agente riesce a creare da solo il symlink in una sessione reale?
      (decide se la fuga e' utilizzabile senza preparazione)
- [ ] il path canonico viene controllato, non quello lessicale
- [ ] nessuna forma di TOCTOU fra controllo e scrittura (`write.ts:27`,
      `edit.ts:45`, `apply_patch.ts:62`)
