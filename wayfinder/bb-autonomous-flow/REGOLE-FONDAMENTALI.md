# REGOLE FONDAMENTALI — bug bounty CyberStrike

Non negoziabili. Valgono per ogni verifica, ogni test, ogni sessione di caccia.
Se una regola contraddice la comodità, vince la regola.

## 1. MAI container su container

**Un solo container alla volta. Nessuna eccezione.**

Un probe non lancia mai il proprio `docker run`. Si riusa il container già
avviato, con `sandbox_exec`.

```bash
cd infra/bounty-sandbox
source ./verify-sandbox-env.sh
sandbox_start                  # UNA volta
sandbox_exec sh -c '...'       # dentro
sandbox_stop                  # SEMPRE a fine lavoro
```

Perché: 6 probe di fila come 6 `docker run` — ogni volta il repo da 5.4GB
rimontato e ~800MB di TUI lanciati, per un risultato identico. Il 28/09 sono
stati avviati sei container di fila; è stato il motivo dello screenshot di
memoria piena.

`sandbox_start` è idempotente: richiamarlo non crea un secondo container.
Verificato: dopo 3 avvii consecutivi, 1 container.

## 2. Al termine di ogni test il container è INTERROTTO

`--rm` non basta: paga il costo e poi butta. Lo stop va eseguito **esplicitamente**.

- `sandbox_stop` a fine lavoro, **anche se il test è fallito**
- un test interrotto lascia comunque un container fermo: rimuoverlo
- dopo ogni sessione: `docker ps -a | grep -i cyberstrike` deve essere vuoto

## 3. Memoria: prima di avviare, misurare

```
free -m    # sotto 2 GB liberi NON si avvia niente
```

Max 1-2 container CyberStrike attivi. Non è un consiglio: 9 sessioni in
parallelo hanno saturato 14GB e **systemd-oomd ha terminato un'applicazione
di sistema**.

Non toccare i container manuali dell'utente (`migharness-test-mssql`, ecc.).

## 4. Nessun test che non misura niente

Ogni verifica di sicurezza, prima di dichiararla verde:

- **CONTROLLO POSITIVO** — dimostra che il soggetto sa fare la cosa *permessa*.
  Un test che scrive "NEGATO" è verde anche se il probe è rotto.
- **`rc` davvero usato** — `rc=$?` catturato e ignorato = test che mente.
- **Marker rimossi prima di ogni run** — un file residuo valida la run
  successiva.
- **Controprova a HEAD** — stash del solo codice sotto test, il test deve
  diventare rosso, ripristino. Se resta verde, non misura niente.

Il 28/09 due test verdi informavano al **contrario** di quello che avevano
misurato. Non è un rischio teorico.

## 5. La verifica di sostanza passa da un subagent avversariale

Il mandato è **trovare il buco**, non confermare che funziona. Se un attacco
non funziona, va detto esplicitamente: non si inventano difetti.

## 6. TOCTOU: la finestra non si chiude in userspace

Se un gate autorizza un path come *stringa* e la syscall lo riapre dopo, un
symlink spostato in mezzo scrive fuori perimetro. Serve: file descriptor
aperto **prima** del gate + `O_NOFOLLOW`. `O_NOFOLLOW` vale solo per l'ultimo
componente.

## 7. Non fidarti dei commenti nel codice

Se un commento asserisce che una finestra "non esiste", quella finestra va
cercata per prima. Era esattamente il caso di `external-directory.ts`.

---

*vitali 2026-09-28, dopo sei container di fila e 1,4GB di processi LSP
residui. Dettagli tecnici: `SANDBOX-RULES.md`, ticket in `tickets/`.*
