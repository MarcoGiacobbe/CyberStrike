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
