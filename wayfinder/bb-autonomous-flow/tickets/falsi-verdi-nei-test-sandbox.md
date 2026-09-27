# Falsi verdi nei test del sandbox — CHIUSO 2026-09-28

Trovati dalla revisione avversariale indipendente su V14/V16, riprodotti e corretti.

## 1. V14: i KO del probe non propagavano (il piu' grave)
`verify-v14-probe.sh` stampava `KO CREDENTIALS PRESENTI` e usciva **comunque con 0**.
`verify-v14-lateral.sh` non guardava quei KO: guardava l'header del probe e i marker
sull'host. Risultato: un montaggio largo della root bug bounty stampava sette KO e
V14 chiudeva con:

    V14: PASS — mount stretti, credenziali e altri programmi assenti,
          scrittura dentro funzionante

cioe' dichiarava esattamente il contrario di quello che aveva appena misurato.
Riprodotto prima di correggere: stesso input, cinque KO, PASS.

Correzione: il probe mette `KO=1` e esce con 1; il test controlla anche il testo dei
KO, perche' l'exit code da solo non distingue "fuga trovata" da "probe crashato".
Controprova: stesso montaggio largo -> ora `V14: FAIL` con i KO elencati.

## 2. V14: il file positivo poteva essere un residuo
Il marker `v14-positivo-$$.txt` veniva cercato con un glob sull'host. Se un run
precedente aveva lasciato il file, il controllo positivo risultava ok anche con il
programma in sola lettura. Ora il probe lo cancella prima di scrivere.

## 3. V16: `rc` catturato e mai usato
`rc=$?` era letto e mai controllato. Un launcher che stampa le tre righe `NEGATO` e
poi esce con 42 faceva passare il test. Dimostrato dal revisore con uno stub.
Ora: `rc != 0` e' KO, e si richiedono esattamente 3 `NEGATO` (una prova incompleta
non puo' passare).

## 4. V16: mancava il controllo positivo
Il test non dimostrava che la scrittura **dentro** `programs/<programma>` funzioni.
"non ha scritto" e "non puo' scrivere" sono esiti diversi: senza il positivo, V16
puo' essere verde perche' il probe e' rotto o perche' il mount del programma e'
sparito. Ora c'e' `test 1b`, e in controprova si vede `POSITIVO: scritto dentro`
accanto ai KO del codice: il confine distingue le due zone.

## 5. Difetto preesistente: la pulizia del test cancella lavoro non committato
`git checkout --` sui due file sorgente ripristina a HEAD, quindi una controprova
distrugge modifiche locali non committate. Il test ora avvisa; la cura vera e'
committare prima di eseguire la controprova.

## Criterio generale emerso
Un test che chiama PASS mentre il proprio probe ha gia' stampato KO non e' un test
debole: e' un test che **informa male**, e perche' il messaggio e' opposto al
reale, e' piu' pericoloso di un test assente. Da qui la regola: il verdetto del
test non puo' essere una stringa scritta a mano; deve discendere dagli stessi
valori che il probe ha usato per decidere.
