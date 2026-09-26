#!/usr/bin/env python3
"""
Legge il log grezzo di pty-drive.py e ricostruisce lo schermo.

Serve per il difetto #14: sapere CHE i byte crescono non basta, bisogna sapore
CHE cosa il TUI mostra. Un render che sovrascrive tutto con spazi produce
byte, e lo schermo e' vuoto: e' il caso peggiore, perche' sembra vivo.

Metodo: replay fedele della sequenza ANSI sul buffer del terminale, non una
regex. Cosi' distinguo "lo schermo contiene testo" da "i byte c'erano ma il
testo e' stato cancellato" — la domanda esatta di #14.

Uso:  python3 tui-screen.py /tmp/tui2.raw [--frames]
"""

import argparse
import re
import sys

CSI = re.compile(rb"\x1b\[([0-9;?]*)([a-zA-Z])")


def render(data: bytes, rows: int = 40, cols: int = 140) -> list[str]:
    """Replay del PTY su un buffer testo: quello che l'utente vedrebbe."""
    screen = [[" "] * cols for _ in range(rows)]
    cr = cc = 0
    i = 0
    while i < len(data):
        b = data[i : i + 1]
        if b == b"\x1b":
            m = CSI.match(data, i)
            if m:
                params, final = m.group(1), m.group(2)
                nums = [int(p) for p in params.split(b";") if p.isdigit()]
                if final == b"H":  # CUP: posizionamento assoluto
                    cr = (nums[0] - 1) if nums else 0
                    cc = (nums[1] - 1) if len(nums) > 1 else 0
                elif final == b"J":  # ED: cancella schermo
                    mode = nums[0] if nums else 0
                    if mode == 2:
                        screen = [[" "] * cols for _ in range(rows)]
                elif final == b"K":  # EL: cancella riga
                    for c in range(cols):
                        screen[cr][c] = " "
                i = m.end()
                continue
            # escape non CSI: salta il byte seguente
            i += 2
            continue
        if b == b"\r":
            cc = 0
        elif b == b"\n":
            cr = min(cr + 1, rows - 1)
        elif b >= b" ":
            if 0 <= cr < rows and 0 <= cc < cols:
                screen[cr][cc] = chr(b[0])
            cc = min(cc + 1, cols - 1)
        i += 1
    return ["".join(r).rstrip() for r in screen]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--cols", type=int, default=140)
    args = ap.parse_args()

    with open(args.path, "rb") as fh:
        data = fh.read()

    lines = render(data, args.rows, args.cols)
    nonempty = [l for l in lines if l.strip()]
    print("=== SCHERMO RICOSTRUITO ===")
    for l in lines:
        print("|" + l)
    print("=== FINE SCHERMO ===")
    print(f"righe non vuote: {len(nonempty)}/{len(lines)}")
    if nonempty:
        print("prima riga con contenuto:")
        for l in nonempty[:3]:
            print("  >", l.strip()[:110])
    return 0


if __name__ == "__main__":
    sys.exit(main())
