#!/usr/bin/env python3
"""
Verifica se il TUI riceve input, e COME.

Il difetto #14 diceva "lo schermo diventa vuoto DOPO l'invio". La misura ha
mostrato che il testo inviato non compare MAI a schermo: non e' un difetto di
render, l'input non entra. Questo strumento isola il canale di input.

Strategia: mando un tasto singolo e non ambiguo (una lettera che non e' una
scorciatoia), e guardo se l'eco appare. Poi provo con le sequenze che un
terminale vero userebbe. Serve a distinguere tre cause con sintomi diversi:

  1. il TUI non legge stdin          -> niente di niente arriva
  2. il TUI legge ma non fa echo     -> i tasti funzionano, non si vede nulla
  3. l'input arriva ma serve un protocollo (bracketed paste / kitty) -> solo
     le sequenze giuste funzionano

Uso:  python3 tui-input.py --key x --out /tmp/inp
"""

import argparse
import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time
import atexit

COLS, ROWS = 140, 40
ANSI_RE = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>()][A-Z0-9]?")


def text_of(data: bytes) -> str:
    return ANSI_RE.sub(b"", data).decode("utf8", "replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cmd", required=True)
    ap.add_argument("--key", default="x")
    ap.add_argument("--mode", default="raw", choices=["raw", "paste", "cr"],
                    help="raw = byte singolo, paste = sequenza bracketed, cr = testo+\\r")
    ap.add_argument("--out", default="/tmp/inp")
    ap.add_argument("--wait", type=float, default=40.0)
    args = ap.parse_args()

    out = args.out + ".raw"
    fh = open(out, "wb")
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = str(COLS)
        os.environ["LINES"] = str(ROWS)
        os.execvp("sh", ["sh", "-c", args.cmd])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    def cleanup() -> None:
        """Termina l'albero di processi del PTY. Vedi pty-drive.py: senza questo
        ogni probe lasciava ~800 MB di Bun vivi e l'oomd ha colpito il PC."""
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
    last_byte = start
    sent = False
    before = 0
    while time.time() - start < args.wait:
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
            last_byte = time.time()
        if not sent and time.time() - last_byte > 2.0 and (time.time() - start) > 6.0:
            with open(out, "rb") as chk:
                before = len(chk.read())
            if args.mode == "raw":
                payload = args.key.encode()
            elif args.mode == "paste":
                payload = b"\x1b[200~" + args.key.encode() + b"\x1b[201~"
            else:
                payload = args.key.encode() + b"\r"
            os.write(fd, payload)
            sent = True
            print(f"INVIATO[{args.mode}] a_s={round(time.time()-start,1)} "
                  f"payload={payload!r}")
            print(f"byte_prima={before}")
    fh.close()

    with open(out, "rb") as chk:
        total = chk.read()
    grew_bytes = len(total) - before
    t = text_of(total)
    print(f"byte_finali={len(total)}")
    print(f"crescita_byte_dopo_invio={grew_bytes}")
    print(f"chiave_'{args.key}'_a_schermo={args.key in t}")
    print(f"crescita_testo_dopo_invio={len(text_of(total[before:]).strip())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
