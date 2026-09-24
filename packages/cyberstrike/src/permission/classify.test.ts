import { describe, expect, test } from "bun:test"
import { classify, pathCandidates } from "./project"

/**
 * Verifica la classificazione dei comandi che `bash.ts` usa per decidere se un
 * comando può scrivere. Il test esercita le STESSE funzioni usate dal tool:
 * una copia della logica nel test verificherebbe solo la copia.
 */

describe("classify — read-only", () => {
  test.each(["ls", "cat", "grep", "dig", "git", "jq", "awk", "echo", "sleep"])(
    "%s è read-only",
    (name) => {
      expect(classify(name)).toBe("read-only")
    },
  )

  test("find NON è nel set read-only: può scrivere con -delete/-exec", () => {
    // find ha -delete e -exec: trattarlo come read-only sarebbe un buco
    expect(classify("find")).not.toBe("read-only")
    expect(classify("find")).toBe("unknown")
  })

  test("un comando sconosciuto non è read-only", () => {
    expect(classify("qualcosa-di-nuovo")).toBe("unknown")
    expect(classify(undefined)).toBe("unknown")
    expect(classify("")).toBe("unknown")
  })
})

describe("classify — write", () => {
  test.each(["rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "tee", "dd", "rsync"])(
    "%s è scrittura",
    (name) => {
      expect(classify(name)).toBe("write")
    },
  )

  test("la precedenza è OPAQUE > WRITE: un comando ambiguo è trattato come opaco", () => {
    // perl è sia in WRITE_COMMANDS (writeFlags -i) sia in OPAQUE: vince OPAQUE,
    // perché un `perl -e "open(...)"` scrive in modo non ispezionabile
    expect(classify("perl")).toBe("opaque")
  })

  test("curl e sed sono trattati come scrittura (possono scrivere con un flag)", () => {
    expect(classify("curl")).toBe("write")
    expect(classify("sed")).toBe("write")
  })
})

describe("classify — opaque (non ispezionabile, va in conferma)", () => {
  test.each([
    "python",
    "python3",
    "node",
    "ruby",
    "php",
    "bash",
    "sh",
    "zsh",
    "eval",
    "exec",
    "sudo",
    "docker",
    "npm",
    "make",
    "gcc",
  ])("%s è opaco", (name) => {
    expect(classify(name)).toBe("opaque")
  })

  test("bash -c è il vettore di elusione: non deve mai essere read-only", () => {
    expect(classify("bash")).toBe("opaque")
    expect(classify("bash")).not.toBe("read-only")
  })
})

describe("pathCandidates — path posizionale", () => {
  test("cp rileva sorgente e destinazione", () => {
    expect(pathCandidates("cp", ["/etc/hosts", "/tmp/copia"])).toEqual(["/etc/hosts", "/tmp/copia"])
  })

  test("rm con flag rileva solo il path", () => {
    expect(pathCandidates("rm", ["-rf", "--force", "/tmp/x"])).toEqual(["/tmp/x"])
  })

  test("mkdir con più path li rileva tutti", () => {
    expect(pathCandidates("mkdir", ["a", "b", "c"])).toEqual(["a", "b", "c"])
  })

  test("chmod salta i flag +x", () => {
    expect(pathCandidates("chmod", ["+x", "script.sh"])).toEqual(["script.sh"])
  })

  test("tee rileva il file", () => {
    expect(pathCandidates("tee", ["/tmp/y"])).toEqual(["/tmp/y"])
  })
})

describe("pathCandidates — flag che introducono un path", () => {
  test("curl -o rileva l'output; l'URL resta candidato ma è innocuo", () => {
    // Un candidato in più che non è un path (un URL) fa fallire il `realpath`
    // e viene scartato: nessun falso positivo. La lista deve garantire che il
    // path VERO ci sia, non che non ce ne siano di spuri.
    expect(pathCandidates("curl", ["-o", "/tmp/out", "https://e.com"])).toEqual(["/tmp/out", "https://e.com"])
  })

  test("wget -O rileva l'output", () => {
    expect(pathCandidates("wget", ["-O", "/tmp/out", "https://e.com"])).toEqual(["/tmp/out", "https://e.com"])
  })

  test("sed -i: il file posizionale è rilevato", () => {
    // `-i` attiva la scrittura ma non introduce un path; l'espressione di sed
    // resta candidata e viene scartata dal realpath (non è un path esistente)
    const candidates = pathCandidates("sed", ["-i", "s/a/b/", "/etc/hosts"])
    expect(candidates).toContain("/etc/hosts")
  })

  test("sed -i senza file non rileva nulla di utile", () => {
    expect(pathCandidates("sed", ["-i", "s/a/b/"])).toEqual(["s/a/b/"])
  })

  test("un flag che non introduce path non consuma l'argomento", () => {
    expect(pathCandidates("sed", ["-n", "1p", "/etc/hosts"])).toEqual(["1p", "/etc/hosts"])
  })
})

describe("pathCandidates — flag chiave=valore", () => {
  test("dd of= rileva solo l'output, non if= né bs=", () => {
    expect(pathCandidates("dd", ["if=/dev/zero", "of=/tmp/x", "bs=1M"])).toEqual(["/tmp/x"])
  })

  test("dd senza of= non produce candidati di scrittura", () => {
    expect(pathCandidates("dd", ["if=/dev/zero", "bs=1M"])).toEqual([])
  })
})

describe("pathCandidates — casi limite", () => {
  test("un comando read-only non ha candidati", () => {
    expect(pathCandidates("ls", ["-la", "/etc"])).toEqual([])
    expect(pathCandidates("grep", ["-r", "x", "/etc"])).toEqual([])
  })

  test("i path con variabile sono marcati, non risolti", () => {
    // `echo x > $VAR` non è risolvibile staticamente: il chiamante li mette in
    // unresolved invece di tentare il realpath
    const candidates = pathCandidates("tee", ["$TARGET"])
    expect(candidates).toEqual(["$TARGET"])
  })

  test("un flag --chiave=valore con = non è un path", () => {
    expect(pathCandidates("rm", ["--one-file-system", "/tmp/x"])).toEqual(["/tmp/x"])
  })
})