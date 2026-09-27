# Path dinamici in bash chiedono conferma invece di negare

**Aperto 2026-09-27. Analisi del codice, non riprodotto.**

## Il difetto

Il classificatore dei comandi bash distingue i path **statici** (che vengono
risolti e confrontati con il perimetro, e vengono negati se sono fuori) dai path
**dinamici** (che non possono essere risolti senza eseguire il comando).

Per i dinamici il codice non nega: **chiede conferma**.

```
bash.ts:296-308   -> bash_unresolved  -> chiede conferma
bash.ts:267-275   -> external_directory (statico) -> nega
```

Le forme dinamiche sono: `$HOME`, `$TMPDIR`, `$VAR`, command substitution
`$(...)`, backtick, e i redirect verso un target non noto
(`bash.ts:132-149`).

## Perche' non e' un difetto minore

`ask` vuol dire che l'operazione **e' consentita** e aspetta solo una decisione.
In un flusso non presidiato — cioe' quando l'utente non e' li a guardare — un
`ask` che nessuno risolve dovrebbe essere un **no**. Il rischio concreto:

- `bash -c "..."` e gli script interpreti sono classificati come **opachi** e
  chiedono conferma senza essere ispezionati (`permission/project.ts:145-212`);
- un `ask` risposto "sempre" una volta diventa un permesso permanente, quindi
  il buco si auto-ripara da solo alla seconda conferma;
- con `BB_ROOT` in `rw` (vedi [fuga-laterale-fra-programmi.md](fuga-laterale-fra-programmi.md)),
  un `ask` risolto basta a raggiungere le credenziali di un altro programma.

Non e' una falla da sfruttare attivamente: e' un buco che si allarga da solo con
l'uso.

## Il caso di `~` nei tool file, che e' diverso e forse piu' subdolo

Nei tool `write`/`edit` il `~` **non e' espanso**:

```
write.ts:26, edit.ts:44   -> "~/.ssh/x" viene unito alla directory del progetto
```

Quindi se il modello chiede di scrivere `~/.ssh/authorized_keys`, il tool
scrive `programs/bcny/~/.ssh/authorized_keys`. Non e' una fuga — e' una
**divergenza silenziosa**: il modello crede di aver configurato SSH, e invece ha
creato una directory tilde dentro il progetto. Il perimetro ha fatto il suo
lavoro e il risultato e' comunque sbagliato, perche' nessuno verifica che la
scrittura sia finita dove richiesto.

Da decidere: espandere `~` (e verificare il risultato espanso) oppure rifiutare
esplicitamente i path con `~` invece di creare directory assurde.

## Test da fare

- [ ] `bash` con `$HOME/prova` -> deve essere negato, non chiesto
- [ ] `bash` con `$(echo /etc/prova)` -> negato (G2 copre l'estrazione, ma non
      il caso del path dinamico)
- [ ] `bash -c "printf x > /etc/prova"` -> opaco: che cosa deve fare?
- [ ] controllo positivo: `bash` con un path statico dentro il perimetro deve
      funzionare, altrimenti il test non prova niente

## Criterio di chiusura

- [ ] un path dinamico fuori dal perimetro e' negato, non chiesto, quando il
      comando non e' ispezionabile
- [ ] `~` e' espanso e verificato, oppure rifiutato esplicitamente
- [ ] deciso cosa significa "opaco": nega, o chiede
