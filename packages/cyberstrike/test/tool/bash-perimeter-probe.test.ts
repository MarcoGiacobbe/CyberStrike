import { describe, expect, test } from "bun:test"
import path from "path"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import type { PermissionNext } from "../../src/permission/next"

/**
 * Comportamento REALE di BashTool.execute(): quali permission vengono chieste e
 * con quali pattern. I test esistenti (classify/pathCandidates) sono test di
 * funzione pura e non esercitano mai il tool: qui si esegue davvero execute()
 * con un ctx finto che registra le richieste di permesso.
 *
 * Le richieste non vengono risolte: ctx.ask ritorna subito, quindi il tool
 * prosegue lo spawn. I comandi sono scelti per essere innocui/istantanei
 * (nessuna dipendenza esterna).
 */

type Req = Omit<PermissionNext.Request, "id" | "sessionID" | "tool">

const baseCtx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

async function run(command: string, workdir?: string) {
  const requests: Req[] = []
  const bash = await BashTool.init()
  const ctx = { ...baseCtx, ask: async (r: Req) => void requests.push(r) }
  await bash
    .execute({ command, description: "probe", ...(workdir ? { workdir } : {}) }, ctx as any)
    .catch(() => {})
  return requests.map((r) => ({ permission: r.permission, patterns: [...r.patterns].sort() }))
}

describe("BashTool.execute() — permission richieste davvero", () => {
  test("cat /etc/passwd (read-only): chiede solo bash, NIENTE external_directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reqs = await run("cat /etc/passwd")
        expect(reqs.find((r) => r.permission === "external_directory")).toBeUndefined()
        expect(reqs.find((r) => r.permission === "bash")!.patterns).toContain("cat /etc/passwd")
      },
    })
  })

  test("ls -la /etc (read-only): chiede solo bash", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reqs = await run("ls -la /etc")
        expect(reqs.find((r) => r.permission === "external_directory")).toBeUndefined()
        expect(reqs.find((r) => r.permission === "bash")!.patterns).toContain("ls -la /etc")
      },
    })
  })

  test("rm -rf /tmp/x (write): external_directory /tmp/* + bash", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reqs = await run("rm -rf /tmp/x")
        expect(reqs.find((r) => r.permission === "external_directory")!.patterns).toContain("/tmp/*")
        expect(reqs.find((r) => r.permission === "bash")!.patterns).toContain("rm -rf /tmp/x")
      },
    })
  })

  test("echo x > /tmp/y (redirect): external_directory /tmp/* + bash", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reqs = await run("echo x > /tmp/y")
        expect(reqs.find((r) => r.permission === "external_directory")!.patterns).toContain("/tmp/*")
        expect(reqs.find((r) => r.permission === "bash")!.patterns).toContain("echo x > /tmp/y")
      },
    })
  })

  test("python3 -c open() (opaque): bash + bash_unresolved", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cmd = `python3 -c "open('/tmp/z','w')"`
        const reqs = await run(cmd)
        expect(reqs.find((r) => r.permission === "bash")!.patterns).toContain(cmd)
        expect(reqs.find((r) => r.permission === "bash_unresolved")!.patterns).toContain(cmd)
      },
    })
  })

  test("sed -i (in-place): external_directory con il file posizionale, non l'espressione", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reqs = await run("sed -i s/a/b/ /etc/hosts")
        const ext = reqs.find((r) => r.permission === "external_directory")
        expect(ext!.patterns).toContain("/etc/*")
        // l'espressione s/a/b/ NON deve diventare un glob
        expect(ext!.patterns.some((p) => p.includes("s/a/b"))).toBe(false)
      },
    })
  })

  test("curl -o /tmp/out: external_directory /tmp/* (il flag -o introduce il path)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reqs = await run("curl -o /tmp/out https://example.com")
        const ext = reqs.find((r) => r.permission === "external_directory")
        expect(ext!.patterns).toContain("/tmp/*")
        // l'URL non deve essere trattato come path
        expect(ext!.patterns.some((p) => p.includes("example.com"))).toBe(false)
      },
    })
  })

  test("dd if=/dev/zero of=/tmp/x: external_directory /tmp/* (solo of=, non if=)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reqs = await run("dd of=/tmp/x", "/tmp")
        const ext = reqs.find((r) => r.permission === "external_directory")
        expect(ext).toBeDefined()
        expect(ext!.patterns).toContain("/tmp/*")
        // if=/dev/zero non deve comparire
        expect(ext!.patterns.some((p) => p.includes("dev/zero"))).toBe(false)
      },
    })
  })

  test("bash -c 'echo x > /tmp/y' (opaque): bash + bash_unresolved", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cmd = `bash -c 'echo x > /tmp/y'`
        const reqs = await run(cmd)
        expect(reqs.find((r) => r.permission === "bash")!.patterns).toContain(cmd)
        expect(reqs.find((r) => r.permission === "bash_unresolved")!.patterns).toContain(cmd)
      },
    })
  })

  // Questi tre casi erano i "gap noti" documentati dal revisore avversariale:
// il target di un redirect dinamico NON produceva alcuna richiesta dedicata
// (o produceva un candidato sbagliato), quindi la scrittura non era confinata.
// Ora il target di un redirect viene catturato come campo `destination` e, se
// contiene un'espansione, mandato in `unresolved` senza passare da `realpath`
// (che altrimenti risolve il literal e lo considera dentro il progetto).
  test("echo x > $TARGET: bash_unresolved sul path non risolvibile (gap chiuso)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reqs = await run("echo x > $TARGET")
        const un = reqs.find((r) => r.permission === "bash_unresolved")
        expect(un).toBeDefined()
        expect(un!.patterns).toContain("$TARGET")
        expect(reqs.find((r) => r.permission === "external_directory")).toBeUndefined()
      },
    })
  })

  test('echo x > "$TARGET": bash_unresolved anche nella forma quoted (gap chiuso)', async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reqs = await run(`echo x > "$TARGET"`)
        const un = reqs.find((r) => r.permission === "bash_unresolved")
        expect(un).toBeDefined()
        expect(un!.patterns).toContain('"$TARGET"')
      },
    })
  })

  // `$TARGET/y` e' una `concatenation`: il bersaglio completo va in `unresolved`,
  // non ridotto all'ultimo `word` (/y), che `realpath` avrebbe risolto dentro cwd.
  test("echo x > $TARGET/y: path completo in unresolved, non il frammento /y (gap chiuso)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reqs = await run("echo x > $TARGET/y")
        const un = reqs.find((r) => r.permission === "bash_unresolved")
        expect(un).toBeDefined()
        expect(un!.patterns).toContain("$TARGET/y")
        expect(un!.patterns).not.toContain("/y")
      },
    })
  })

  test("comandi della vecchia lista chiusa: esito reale per ciascuno", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const table: Record<string, { ext?: string; bash: string }> = {
          "cd /etc": { ext: "/etc/*", bash: undefined as any },
          "rm /tmp/a": { ext: "/tmp/*", bash: "rm /tmp/a" },
          "cp /tmp/a /tmp/b": { ext: "/tmp/*", bash: "cp /tmp/a /tmp/b" },
          "mv /tmp/a /tmp/b": { ext: "/tmp/*", bash: "mv /tmp/a /tmp/b" },
          "mkdir /tmp/newdir": { ext: "/tmp/newdir/*", bash: "mkdir /tmp/newdir" },
          "touch /tmp/newfile": { ext: "/tmp/*", bash: "touch /tmp/newfile" },
          "chmod 755 /tmp/f": { ext: "/tmp/*", bash: "chmod 755 /tmp/f" },
          "chown root /tmp/f": { ext: "/tmp/*", bash: "chown root /tmp/f" },
        }
        for (const [cmd, exp] of Object.entries(table)) {
          const reqs = await run(cmd)
          console.log(`[REAL] ${cmd} ->`, JSON.stringify(reqs))
          const ext = reqs.find((r) => r.permission === "external_directory")
          expect(ext!.patterns).toContain(exp.ext!)
          if (exp.bash) {
            expect(reqs.find((r) => r.permission === "bash")!.patterns).toContain(exp.bash)
          }
        }
      },
    })
  })
})