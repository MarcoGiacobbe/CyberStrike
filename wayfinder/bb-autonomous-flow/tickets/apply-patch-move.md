# apply_patch move_path — CHIUSO 2026-09-28

## Due difetti, entrambi reali
1. `assertExternalDirectory(ctx, movePath)` veniva chiamata ma il RISULTATO era
   scartato: la validazione girava e poi nessuno ne faceva niente.
2. la scrittura usava `fs.writeFile`, che riapre il path per nome. Fra il gate e
   quella riga un symlink spostava la destinazione.

Misurato col perimetro in regola (allow:1 deny:0): il contenuto di un ALTRO
programma (`programs/bcny-test/bersaglio.txt`, contenuto SEGRETO) veniva
sovrascritto dal contenuto del file spostato.

## Correzione
- il path canonico restituito da `assertExternalDirectory` viene USATO
- la scrittura passa da `openChecked`/`writeChecked` con `O_NOFOLLOW`

Stessa difesa di write.ts: userspace da solo non chiude la finestra.

## Verifica
- test permanente `test/permission/apply-patch-move.test.ts`: verde col fix
- CONTROPROVA: rosso con apply_patch.ts a HEAD — il test misura il buco
- col fix la vittima resta SEGRETO e il kernel risponde ELOOP
- typecheck 11/11, suite 945 pass / 0 fail
