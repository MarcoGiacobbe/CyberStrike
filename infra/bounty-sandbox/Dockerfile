# bounty: ambiente di hunting per l'agente CyberStrike.
#
# Il confine NON e' "quali comandi sono permessi" (quello lo fa il gate in JS,
# dentro il container): e' che questo filesystem non contiene la tura macchina.
# /home/marco non e' montato, /etc e' un filesystem vuoto, e l'unica zona
# scrivibile utile e' /work.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Tool di hunting. sqlmap/nuclei/httpx/ffuf/nmap: i raw socket di nmap sono
# l'unico punto che richiede una capability (vedi ticket, fase 1.3).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git jq python3 python3-pip \
      nmap netcat-openbsd openssh-client dnsutils iproute2 \
      ripgrep less procps file unzip \
      chromium chromium-driver chromium-sandbox \
    && rm -rf /var/lib/apt/lists/*

# Chromium ha bisogno di /dev/shm piu' grande della meta' RAM: senza, il browser
# headless crasha con "Failed to move to new namespace" su /dev/shm piccolo.
# Chrome usa i namespace per l'isolamento dei processi helper.
RUN mkdir -p /dev/shm && chmod 1777 /dev/shm

# "No usable sandbox": Chromium ha bisogno di user namespace non privilegiati.
# Il pacchetto chromium-sandbox fornisce il SUID helper, ma in un container con
# --cap-drop=ALL + no-new-privileges non puo' funzionare: SUID e' esattamente
# cio' che no-new-privileges blocca. Si puo' invece lasciare i USER namespace
# abilitati: sono isolati per costruzione, non richiedono capacita'.
# MISURATO: con il pacchetto installato ma i namespace disabilitati,
# l'avvio fallisce. Serve SYS_ADMIN OPPURE usare i namespace.

# Struttura delle cartelle di lavoro. programmi/ e' l'unica zona con dati
# persistenti; sorgenti/ e' in sola lettura per costruzione (la RO la mette
# il mount, non qui: qui si dichiara l'intento).
RUN mkdir -p /work/programmi /work/sorgenti /work/bin \
    && chmod 755 /work /work/bin

# Nessun binario docker dentro: se l'agente potesse avviare container
# annidati, il confine sarebbe annullato. docker si usa dall'host.
WORKDIR /work

# Nessun utente root per default: --cap-drop=ALL senza root e' la forma piu'
# forte (niente CAP_SETUID da usare per l'escalation).
RUN useradd -m -u 1000 hunter
USER hunter

CMD ["/bin/bash"]
