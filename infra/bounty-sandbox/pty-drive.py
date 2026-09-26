#!/usr/bin/env python3
"""
Misura il difetto #14: lo schermo diventa vuoto DOPO l'invio del messaggio.

Il punto di questo strumento e' UNA SOLA DOMANDA: dopo l'invio, i byte sul PTY
crescono ancora? Perche' le due cause hanno rumore diverse e si confondono:

  - i byte CRESCONO   -> il provider ha risposto, il difetto e' di RENDERING
  - i byte SONO FERMI -> nessuna risposta e' arrivata, il difetto e' a MONTE

Tutto quello che c'e' stato prima (il TUI disegna, 11049 byte, ESC, colori) non
basta a distinguere le due: quel byte arrivava PRIMA dell'invio, ed e' esattamente
per questo che il difetto non era mai stato isolato.

Non guida il TUI con caratteri grezzi: la `c` viene letta come scorciatoia e
apre la command palette (vedi #14). Uso invece il protocollo di input del TUI.

Uso:
  python3 pty-drive.py --out /tmp/tui --cmd "<comando>" --send-after 6 --hold 30
"""

import argparse
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import atexit
import time
from typing import Any

# Il TUI e' un'app a schermo intero: serve una dimensione esplicita, altrimenti
# il fallback e' 0x0 e non disegna (vedi ticket TUI, misura del 2026-09-25).
COLS, ROWS = 140, 40

# Una risposta del provider non e' vuota e non e' un errore. Se esce una di
# queste, il difetto e' a monte e lo vediamo subito.
ERROR_RE = re.compile(
    rb"(401|403|429|500|502|503|no providers found|"
    rb"Cannot find module|ECONNREFUSED|ETIMEDOUT|"
    rb"API error|Unexpected error|Unauthorized|invalid_api_key)",
    re.I,
)
ANSI_RE = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>()][A-Z0-9]?")


def visible_length(data: bytes) -> int:
    """Byte di testo visibili: tolgo le sequenze ANSI e gli spazi finali."""
    return len(ANSI_RE.sub(b"", data).strip())


def snapshot(path: str) -> tuple[int, int]:
    """(byte totali, byte di testo visibili) del log corrente."""
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except FileNotFoundError:
        return (0, 0)
    return (len(data), visible_length(data))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cmd", required=True, help="comando da eseguire nel PTY")
    ap.add_argument("--out", default="/tmp/tui")
    ap.add_argument("--send-after", type=float, default=6.0,
                    help="attesa minima PRIMA di inviare (il TUI deve disegnare)")
    ap.add_argument("--settle", type=float, default=1.5,
                    help="secondi di silenzio richiesti DOPO l'ultimo byte, "
                         "perche' il TUI e' a schermo intero: arriva a raffica")
    ap.add_argument("--hold", type=float, default=30.0,
                    help="secondi da attendere DOPO l'invio per vedere se arrivano byte")
    ap.add_argument("--send", default="",
                    help="testo da inviare dopo --send-after")
    args = ap.parse_args()

    out = args.out + ".raw"
    fh = open(out, "wb")
    pid, fd = pty.fork()

    if pid == 0:  # processo figlio
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = str(COLS)
        os.environ["LINES"] = str(ROWS)
        os.execvp("sh", ["sh", "-c", args.cmd])

    # Padre: impongo la dimensione, altrimenti il TUI non disegna.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    def cleanup() -> None:
        """Termina l'ALBERO di processi del PTY, non solo la shell intermedia.

        Senza questo ogni misura lasciava ~800 MB di Bun vivi: nove misure
        hanno saturato la RAM (14 GB) e fatto intervenire l'oomd, che ha
        ucciso un'applicazione di sistema. Lo strumento di misura non puo'
        essere la causa del difetto che misura.
        """
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, sig)
            except (ProcessLookupError, PermissionError, OSError):
                return
            time.sleep(0.4)
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
                if done:
                    return
            except ChildProcessError:
                return

    atexit.register(cleanup)
    signal.signal(signal.SIGTERM, lambda *_: (cleanup(), sys.exit(143)))

    start = time.time()
    last_byte_at = start
    sent_at = None
    phase = "prima_dell_invio"
    stats: dict[str, Any] = {}

    total_drawn = 0
    # Due orologi distinti: `send_at` governa l'invio, `end_at` l'uscita.
    # Riutilizzare lo stesso valore per entrambi faceva non terminare mai.
    send_at = args.send_after
    end_at = args.send_after + args.hold
    while True:
        now = time.time() - start
        if now > end_at:
            break

        r, _, _ = select.select([fd], [], [], 0.25)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            fh.write(data)
            fh.flush()
            last_byte_at = time.time()
            total_drawn += len(data)
        else:
            # Nessun byte: il TUI e' vivo ma non sta scrivendo. Annoto il vuoto,
            # cosi' la domanda "quando si e' svuotato" ha una risposta.
            stats.setdefault("silenzio_a_s", []).append(round(now, 1))

        quiet = time.time() - last_byte_at
        ready = now >= send_at and quiet >= args.settle
        if sent_at is None and args.send and ready and total_drawn > 0:
            # Pasted come testo unito: niente sequenze di controllo, niente
            # scorciatoie da tastiera. Ogni char di una scorciatoia aprirebbe
            # la command palette invece di comporre il messaggio.
            payload = args.send.replace("\n", "\r") + "\r"
            os.write(fd, payload.encode())
            sent_at = time.time()
            stats["inviato_a_s"] = round(sent_at - start, 1)
            stats["attesa_per_silenzio_s"] = round(args.settle, 1)
            stats["testo_inviato"] = args.send
            # Fase 2: da qui in poi mi interessa solo la CRESCITA.
            before = snapshot(out)
            stats["byte_al_momento_dell_invio"] = before[0]
            stats["testo_al_momento_dell_invio"] = before[1]
            end_at = sent_at + args.hold  # aspetto la risposta per `hold` secondi

    fh.close()

    total_after, text_after = snapshot(out)
    stats["byte_finali"] = total_after
    stats["testo_finale"] = text_after
    if "byte_al_momento_dell_invio" in stats:
        stats["crescita_byte"] = total_after - stats["byte_al_momento_dell_invio"]
        stats["crescita_testo"] = text_after - stats["testo_al_momento_dell_invio"]
        stats["VERDETTO"] = (
            "RISPOSTA_RENDERIZZATA" if stats["crescita_testo"] > 0
            else "NESSUNA_RISPOSTA_A_MONTE"
        )
    stats["log_grezzo"] = out

    if not args.send:
        stats["VERDETTO"] = "SOLO_AVVIO_NON_MISURATO"

    for k, v in stats.items():
        print(f"{k}: {v}")

    # Il contenuto utile, ripulito dagli ANSI, per leggere l'errore se c'e'.
    with open(out, "rb") as fh2:
        raw = fh2.read()
    errors = ERROR_RE.findall(ANSI_RE.sub(b"", raw))
    if errors:
        print("ERRORI_TROVATI:", sorted({e.decode() for e in errors}))
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGINT, lambda *_: sys.exit(130))
    main()
