# TOCTOU fra gate e scrittura — CHIUSO 2026-09-28

## Difetto
`assertExternalDirectory` autorizzava `programs/bcny/race.txt` (allow:1 deny:0)
e il file di un ALTRO programma (`programs/bcny-test/bersaglio.txt`, contenuto
`SEGRETO`) veniva lo stesso sovrascritto. Causa: il gate restituiva un path
come STRINGA, e quel nome veniva riaperto dalla syscall DOPO l'autorizzazione.
Fra i due momenti un symlink spostava la destinazione.

Il commento nel codice affermava che "controllo e scrittura riguardano lo
stesso inode e NON ESISTE FINESTRA in cui un symlink possa cambiarli".
L'affermazione era falsa, e il commento l'ha tenuta viva.

## Controprova reciproca
- gate saltato -> `SEGRETO` intatto (il perimetro non e' il problema)
- gate eseguito, sorgente a HEAD -> `DENTRO` sovrascritto (il buco e' reale)
- gate eseguito, col fix -> `SEGRETO` intatto (il fix chiude)

## Correzione
`openChecked` apre l'handle PRIMA del gate e usa `O_NOFOLLOW`.
Il kernel rifiuta il symlink (ELOOP) invece di seguirlo: verificato che
un file nuovo passa e il symlink no. userspace da solo non puo' chiudere
questa finestra.

`O_NOFOLLOW` vale solo per l'ultimo componente: una directory padre che e' un
symlink resta seguita, e per quello continua a servire `assertExternalDirectory`.

## Costo
Un handle per ogni scrittura, aperto prima del gate. `FileTime` lo conta come
accesso, quindi i file mai letti vanno letti prima: comportamento gia' richiesto
dal tool, verificato dalla CONTROLLO POSITIVO della suite.

## Verifica
- `test/permission/toctou-race.test.ts` permanente: verde col fix, ROSSO a HEAD
- `bun turbo typecheck --force`: 11/11
- `bun test test/tool test/permission test/session`: 944 pass, 0 fail
