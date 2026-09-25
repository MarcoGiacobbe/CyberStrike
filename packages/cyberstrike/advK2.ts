// Divergenza TRA LIVELLI su "<symlink>/..": kernel (open/chdir diretto) vs realpath/JS.
import fs from "fs"
import os from "os"
import path from "path"
const B = fs.mkdtempSync(path.join(os.tmpdir(), "advK2-"))
const prog = path.join(B, "prog")
const victim = path.join(B, "victim")
fs.mkdirSync(path.join(victim, "sub"), { recursive: true })
fs.mkdirSync(prog, { recursive: true })
fs.writeFileSync(path.join(victim, "MARKER"), "vittima")
fs.symlinkSync(path.join(victim, "sub"), path.join(prog, "s"))
const dir = path.join(prog, "s", "..")

const py = (code: string) => Bun.spawnSync(["python3", "-c", code, dir])
console.log("dir =", dir)

// KERNEL PURO: os.open/os.listdir/os.chdir senza normalizzazione lato libc/python
let r = py(`import os,sys
d=sys.argv[1]
fd=os.open(d, os.O_RDONLY|os.O_DIRECTORY)
print("os.open+listdir ->", sorted(os.listdir(fd)))
print("os.stat(MARKER)  ->", os.path.exists(os.path.join(d,"MARKER")))
try:
    os.chdir(d); print("os.chdir -> getcwd:", os.getcwd())
except Exception as e: print("chdir err", e)
try:
    print("open(d+'/MARKER') ->", open(os.path.join(d,"MARKER")).read())
except Exception as e: print("open MARKER:", type(e).__name__, e)`)
console.log(r.stdout.toString().trim(), r.stderr.toString().trim())

// C-level: usa la syscall diretta via ctypes (openat) per escludere ogni dubbio
r = py(`import ctypes, os, sys
libc = ctypes.CDLL("libc.so.6", use_errno=True)
d = sys.argv[1].encode()
fd = libc.open(d, 0)  # O_RDONLY
print("syscall open() fd =", fd, "errno", ctypes.get_errno())
if fd >= 0:
    buf = ctypes.create_string_buffer(4096)
    libc.getcwd.restype = ctypes.c_char_p
    import os
    print("fd dir entries via /proc:", sorted(os.listdir('/proc/self/fd/%d' % fd)))
    print("readlink /proc/self/fd/%d ->" % fd, os.readlink('/proc/self/fd/%d' % fd))`)
console.log(r.stdout.toString().trim(), r.stderr.toString().trim())

// JS/Bun
console.log("Bun fs.realpathSync(dir)      =", fs.realpathSync(dir))
console.log("Bun fs.readdirSync(dir)       =", fs.readdirSync(dir))
console.log("Bun fs.existsSync(dir/MARKER) =", fs.existsSync(path.join(dir, "MARKER")))
console.log("path.resolve(dir)             =", path.resolve(dir))
console.log("B =", B)