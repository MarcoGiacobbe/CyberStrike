# Verifiche del sandbox: TUTTI i test devono passare da qui

## Il problema
Fino al 2026-09-28 ogni probe lanciava il proprio `docker run`:
V14, V16, controprova V14, controprova V16, piu' il TUI. Sei container di
fila, ognuno con ~800MB di TUI e il mount del repo da 5.4GB rimontato da capo.
Il risultato era identico, il costo si ripeteva a ogni test.

## Come si usa
```bash
cd infra/bounty-sandbox
source ./verify-sandbox-env.sh
sandbox_start                       # UNA volta sola
sandbox_exec sh -c 'qualcosa'      # dentro il container riusato
sandbox_stop                       # quando finito
```

`sandbox_start` e' idempotente: richiamarlo non crea un secondo container.
L'avvio costa ~0.37s, contro i decini di secondi di un `docker run` da zero.
Il container `sleep infinity` occupa ~4MiB, contro gli ~800MB di un TUI.

## Regole
- **Mai piu' `docker run` per un test.** Se serve eseguire qualcosa dentro,
  si usa `sandbox_exec` sul container gia' avviato.
- **Mai piu' di 1-2 container CyberStrike attivi.** Sono ~800MB ciascuno:
  9 sessioni in parallelo hanno saturato 14GB e fatto terminare
  systemd-oomd un'applicazione di sistema.
- **`sandbox_stop` SEMPRE a fine lavoro**, anche se il test e' fallito.
- Prima di ogni lanzo: `free -m`. Sotto 2GB liberi non si avvia niente.

## Cosa NON puo' fare
Il container di verifica ha `/app` in sola lettura e il solo programma del
test montato in rw. Non e' il sandbox di caccia: per quello c'e'
`run-sandbox.sh`. Qui si verificano i test, non si cacciano bug.

## Attenzione
`verify-sandbox-env.sh` NON accumula container, ma i vecchi script V14/V16
lanciano ancora il proprio `docker run`. Migrarli e' il passo successivo.
