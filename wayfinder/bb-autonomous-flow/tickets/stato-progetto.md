# Ticket: stato del progetto (fatti verificabili vs narrazione)

## Question

Definire cos'è lo "stato attuale" di un progetto di hunting, chi lo scrive, cosa
contiene e come si garantisce che non venga ripetuto lavoro già fatto tra una
sessione e l'altra.

Origine: esigenza utente — *"all'inizio di ogni sessione, prima di generare i
TODO, deve OBBLIGATORIAMENTE leggere lo stato attuale per non ripetere ciò che
ha fatto"*.

## Principio adottato

**Lo stato non è un file che l'agente legge: è un vincolo che il sistema impone.**

La formulazione "leggere lo stato prima dei TODO" è un'istruzione di prompt, e
un'istruzione di prompt non è una garanzia: salta se il contesto è lungo, se il
modello è debole, se l'utente chiede altro. Un requisito che deve valere SEMPRE
si impone con la meccanica.

Implementazione decisa (utente, 2026-09-24):
- **Tool bloccato meccanicamente**: l'agente NON ha `todowrite` finché non ha
  caricato lo stato. Non è un ordine, è un tool che gli manca.
- **Più regola nel prompt come rinforzo** (entrambi, non alternativi).

## Separazione fatti / narrazione (deciso)

| Cosa | Dove | Autorevolezza |
|---|---|---|
| Fase corrente, target toccati | `state.json` | Fatto |
| Vuln trovate + triage (aperta/segnalata/risolta) | `state.json` | Fatto |
| Account creati | `accounts.json` (già esiste) | Fatto |
| Evidenza crawl | `crawls/` | Evidenza grezza |
| **Note libere dell'agente** | `notes/` | **NON autorevole — mai letto come stato** |
| "Cosa ho fatto l'ultima volta" | sessioni CyberStrike | **NON duplicare nello stato** |
| Il piano TODO | sessioni CyberStrike | **NON duplicare nello stato** |

Regola chiave: **nello stato solo affermazioni che un comando sa dimostrare.**
Un LLM che scrive "ho testato l'endpoint X" senza evidenza non deve poter
inquinare lo stato. Tutto ciò che è narrazione va in `notes/`, esplicitamente
marcata non autorevole.

Perché conta: se narrazione e stato stanno insieme, al riavvio il caricamento
dello stato diventa una scansione di appunti e l'agente passa il tempo a leggere
sé stesso invece di lavorare. Lo stato deve essere **piccolo, tipizzato,
versionato, caricato sempre per intero**; i file utili **tanti, cercabili, letti
su richiesta**.

## Chi aggiorna lo stato (deciso: ibrido)

- **Push**: fase e triage — i comandi li aggiornano quando fanno qualcosa
- **Pull**: i fatti (target toccati, report presenti) — derivati dall'evidenza a
  ogni lettura

Motivo: se l'agente dimentica un aggiornamento push, lo stato pecca per DIFETTO,
non MENTE. La direzione dell'errore conta: uno stato incompleto è recuperabile,
uno stato che dichiara il falso no.

## Disallineamento (deciso: blocco)

Se lo stato dichiarato è disallineato dai fatti che il sistema conosce (es.
l'agente dichiara di aver testato X ma non c'è traccia di richieste su X):
**la sessione si blocca finché non si risincronizza il programma.**

## Da decidere

1. Forma dello stato: `state.json` con schema versionato (chi lo valida? zod?
   chi migra su cambio schema?)
2. Confine fra stato e programma: `program.json` si risincronizza e si
   sovrascrive; `state.json` NO. Come si garantisce che `bb sync` non li
   confonda (il sync oggi preserva `identity` — stesso pattern da estendere?)
3. Granularità dei "target toccati": per host, per URL, per endpoint? Un crawl
   che esplora 30 pagine su un host tocca 1 cosa o 30?
4. Cosa significa "target toccato" per un'azione fatta con `curl` o `bash` fuori
   dal crawler (che non lascia evidenza strutturata)? È il buco nero dello stato
   derivato: da decidere.
5. Staleness: dopo quanto tempo/qual cambiamento lo stato va considerato vecchio
   e il programma risincronizzato? (collegato a `lastUpdated` in `program.json`)
6. Chi promuove una nota di `notes/` a fatto verificato — solo un comando, o
   anche l'utente a mano?