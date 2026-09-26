#!/bin/bash
# V11 — tentativo di fuga REALE. Non un test di codice: qui non gira nessun
# permesso, nessun gate, nessun pattern. Solo il filesystem del container.
# Se un file fuori /work viene creato, il confine e' rotto.

set -u
FAIL=0
ok()   { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1"; FAIL=1; }

echo "=== Chi sono ==="
id
echo "--- capabilities ---"
grep Cap /proc/self/status
echo "--- il tuo home esiste qui? ---"
ls -la /home/ 2>&1 | head -5

echo
echo "=== FUGA 1: scrivere in /etc ==="
if touch /etc/pwned 2>/dev/null && [ -f /etc/pwned ]; then bad "/etc/pwned CREATO"; rm -f /etc/pwned; else ok "/etc non scrivibile"; fi

echo
echo "=== FUGA 2: /home/marco (la tua home reale) ==="
mkdir -p /home/marco 2>/dev/null
if touch /home/marco/PWNED 2>/dev/null && [ -f /home/marco/PWNED ]; then bad "home montata o creata"; rm -f /home/marco/PWNED; else ok "/home/marco inesistente"; fi

echo
echo "=== FUGA 3: /root ==="
if touch /root/PWNED 2>/dev/null && [ -f /root/PWNED ]; then bad "/root scrivibile"; rm -f /root/PWNED; else ok "/root non scrivibile"; fi

echo
echo "=== FUGA 4: SSH keys ==="
if ls /root/.ssh/id_rsa >/dev/null 2>&1 || ls ~/.ssh/id_rsa >/dev/null 2>&1; then bad "chiavi SSH PRESENTI"; else ok "nessuna chiave SSH dentro"; fi

echo
echo "=== FUGA 5: /var/run/docker.sock (il vero buco) ==="
if [ -S /var/run/docker.sock ]; then bad "SOCKET DOCKER MONTATO — il confine e' annullato"; else ok "socket docker assente"; fi

echo
echo "=== FUGA 6: socket host, /proc, escape classici ==="
ls /proc/1/ns/mnt >/dev/null 2>&1 && ok "namespace mnt visibile (atteso su Linux)" || bad "namespace assente"
echo "--- /etc/hosts contiene l'host? ---"
grep -q "host.docker.internal" /etc/hosts && echo "  ⚠️  host.docker.internal presente" || ok "nessun riferimento all'host"

echo
echo "=== SCRITTURA LEGITTIMA: /work deve funzionare ==="
if touch /work/programmi/PROVA && [ -f /work/programmi/PROVA ]; then ok "scrittura in /work consentita (serve!)"; rm -f /work/programmi/PROVA; else bad "/work NON scrivibile — sandbox inutilizzabile"; fi

echo
echo "=== TOOL DI HUNTING ==="
for t in nmap curl python3 nc git rg jq; do
  command -v $t >/dev/null 2>&1 && ok "$t presente" || bad "$t ASSENTE"
done

echo
echo "=== nmap: i raw socket funzionano? ==="
# ATTENZIONE: `nmap -h` non e' un target valido e nmap esce comunque 0 stampando
# l'usage. Un test che guarda solo `$?` dice "funziona" anche quando la scansione
# e' fallita: e' esattamente il difetto che questo test aveva la prima volta.
# Si verifica che l'output contenga un risultato di scansione, non il usage.
nmap -sS -p 80 -Pn 127.0.0.1 >/tmp/syn.txt 2>&1
if grep -q "Nmap scan report\|Nmap done" /tmp/syn.txt; then
  ok "nmap -sS (SYN scan) FUNZIONA"
else
  echo "  ⚠️  nmap -sS NON funziona: richiede root + NET_RAW (CapEff=0 senza root)"
fi
nmap -sT -p 80 -Pn 127.0.0.1 >/tmp/tcp.txt 2>&1
if grep -q "Nmap scan report\|Nmap done" /tmp/tcp.txt; then
  ok "nmap -sT (TCP connect) FUNZIONA senza privilegi"
else
  bad "nmap -sT non funziona: la sandbox e' inutilizzabile per scanning"
fi

echo
[ $FAIL -eq 0 ] && echo "=== VERDETTO: nessuna fuga ===" || echo "=== VERDETTO: FUGA RILEVATA ==="
exit $FAIL
