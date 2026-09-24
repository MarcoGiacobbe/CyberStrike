import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language } from "web-tree-sitter"

import { $ } from "bun"
import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { classify, pathCandidates } from "@/permission/project"
import { Truncate } from "./truncation"
import { Plugin } from "@/plugin"

const MAX_METADATA_LENGTH = 30_000

// Detect binary content in a buffer by checking for high density of
// non-printable bytes. Printable = ASCII 0x20-0x7E, tab, newline, CR, ESC
// (for ANSI colors). If >30% of bytes are non-printable, treat as binary.
function isBinaryBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return false
  let nonPrintable = 0
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b >= 0x20 && b <= 0x7e) continue
    if (b === 0x09 || b === 0x0a || b === 0x0d || b === 0x1b) continue
    if (b >= 0xc0) continue // UTF-8 lead bytes
    if (b >= 0x80 && b <= 0xbf) continue // UTF-8 continuation
    nonPrintable++
  }
  return nonPrintable / buf.length > 0.3
}
const DEFAULT_TIMEOUT = Flag.CYBERSTRIKE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  log.info("bash tool using shell", { shell })

  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      const cwd = params.workdir || Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const tree = await parser().then((p) => p.parse(params.command))
      if (!tree) {
        throw new Error("Failed to parse command")
      }
      const directories = new Set<string>()
      if (!Instance.containsPath(cwd)) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()
      // percorsi non risolvibili staticamente ($VAR, backtick) e comandi opachi
      // (python3 -c ...): entrambi non decidibili -> conferma esplicita
      const unresolved = new Set<string>()
      const opaque = new Set<string>()

      // I `file_redirect` vanno raccolti a LIVELLO DI ALBERO, non dentro il loop
      // sui comandi: uno shell statement può essere un redirect nudo senza alcun
      // nodo `command` (`> /tmp/x`, `2> /tmp/x`, `( > /tmp/x )`, `{ > /tmp/x; }`).
      // In quelle forme il loop sottostante non entrerebbe mai e la scrittura
      // passerebbe senza alcun controllo — `> file` è anche una primitiva di
      // troncamento (`>` azzera il file senza eseguire nulla).
      const allRedirects: any[] = tree.rootNode.descendantsOfType("file_redirect")
      const redirectTargets: string[] = []
      for (const redirect of allRedirects) {
        if (!redirect) continue
        // Il target è il campo `destination`, che può essere un nodo `word`
        // (`> /tmp/x`), `string` (`> "$VAR"`), `raw_string` (`> '$VAR'`) o
        // `concatenation` (`> "$DIR"/f`). `descendantsOfType("word")` NON
        // attraversa i nodi `string`, quindi la forma quoted (`> "$VAR"`)
        // sfuggirebbe del tutto: la cattura va fatta sul campo, non sul tipo.
        const dest = redirect.childForFieldName?.("destination")
        const target = dest?.text ?? undefined
        // Un target che contiene un'espansione (`$VAR`, backtick) NON è un path
        // statico e non va dato in pasto a `realpath`: coreutils risolve il
        // literal (anche quoted) come un nome di file e lo considera dentro il
        // progetto, facendo sparire la scrittura dal controllo. Il discrimine
        // va fatto sull'albero (`simple_expansion`/`expansion`/`command_substitution`),
        // non sul testo.
        const dinamico =
          dest &&
          (dest.type === "simple_expansion" ||
            dest.type === "expansion" ||
            dest.type === "command_substitution" ||
            dest.descendantsOfType("simple_expansion").length > 0 ||
            dest.descendantsOfType("expansion").length > 0 ||
            dest.descendantsOfType("command_substitution").length > 0)
        if (target) {
          if (dinamico) {
            unresolved.add(target)
            continue
          }
          redirectTargets.push(target)
        }
      }

      // (1) Raccolta dei candidati: argomenti dei comandi di scrittura + ogni
      // redirect, indifferentemente dal fatto che il redirect abbia un comando.
      const candidateSet = new Set<string>()
      for (const node of tree.rootNode.descendantsOfType("command")) {
        if (!node) continue

        // Get full command text including redirects if present
        let commandText = node.parent?.type === "redirected_statement" ? node.parent.text : node.text

        const command = []
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (!child) continue
          if (
            child.type !== "command_name" &&
            child.type !== "word" &&
            child.type !== "string" &&
            child.type !== "raw_string" &&
            child.type !== "concatenation"
          ) {
            continue
          }
          command.push(child.text)
        }

        // Classificazione del comando (perimetro bug bounty):
        //   read-only -> nessun controllo
        //   write     -> il path viene risolto e confrontato col perimetro
        //   opaque    -> scrittura non ispezionabile -> conferma
        //   unknown   -> non classificato -> conferma
        const name = command[0]
        const kind = classify(name)

        if (kind === "write") {
          for (const c of pathCandidates(name, command)) candidateSet.add(c)
        }

        if (kind === "opaque") {
          // scrittura non ispezionabile staticamente (`python3 -c "open(...)"`):
          // non si rileva il path, si manda il comando in conferma.
          opaque.add(commandText)
        }

        // cd covered by above check
        if (command.length && command[0] !== "cd") {
          patterns.add(commandText)
          always.add(BashArity.prefix(command).join(" ") + " *")
        }
      }

      // I redirect contano come scrittura a prescindere dal comando: il path è
      // strutturale, non testuale. Vanno aggiunti QUI, fuori dal loop: un
      // redirect nudo (`> /tmp/x`) non ha alcun nodo `command`, quindi il loop
      // sopra non lo visiterebbe mai e la scrittura passerebbe in silenzio.
      for (const target of redirectTargets) candidateSet.add(target)

      // (2) Risoluzione: unico punto, così il confine vale allo stesso modo per
      // argomenti e redirect.
      for (const arg of candidateSet) {
        if (arg.startsWith("$") || arg.startsWith("`")) {
          // path non risolvibile staticamente: non si può decidere, si chiede
          unresolved.add(arg)
          continue
        }
        const resolved = await $`realpath ${arg}`
          .cwd(cwd)
          .quiet()
          .nothrow()
          .text()
          .then((x) => x.trim())
        log.info("resolved path", { arg, resolved })
        if (resolved) {
          // Git Bash on Windows returns Unix-style paths like /c/Users/...
          const normalized =
            process.platform === "win32" && resolved.match(/^\/[a-z]\//)
              ? resolved.replace(/^\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, "\\")
              : resolved
          if (!Instance.containsPath(normalized)) {
            const dir = (await Filesystem.isDir(normalized)) ? normalized : path.dirname(normalized)
            directories.add(dir)
          }
        } else {
          // `realpath` fallisce se il path non esiste ancora (o se il
          // comando lo crea lui: `mkdir -p /tmp/nuova/a`, `install -D ...`).
          // Scartare il candidato qui lo farebbe sparire dal controllo: il
          // confine diventerebbe un effetto collaterale della risoluzione
          // riuscita, non una proprietà del comando. Il path non risolto
          // non è decidibile -> conferma esplicita.
          unresolved.add(arg)
        }
      }

      if (directories.size > 0) {
        const globs = Array.from(directories).map((dir) => path.join(dir, "*"))
        await ctx.ask({
          permission: "external_directory",
          patterns: globs,
          always: globs,
          metadata: {},
        })
      }

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      // Comandi a scrittura opaca (`python3 -c "open('/tmp/x','w')"`) o con
      // path non risolvibile staticamente (`echo x > $VAR`): non si può sapere
      // se e dove scrivono, quindi NON passano in silenzio. La conferma è
      // distinta dalle altre così l'utente vede esattamente perché.
      if (opaque.size > 0 || unresolved.size > 0) {
        await ctx.ask({
          permission: "bash_unresolved",
          patterns: Array.from(opaque).concat(Array.from(unresolved)),
          always: Array.from(opaque).map((c) => BashArity.prefix(c.split(/\s+/)).join(" ") + " *"),
          metadata: {
            reason: "command may write outside the project without a statically detectable path",
          },
        })
      }

      const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })
      const proc = spawn(params.command, {
        shell,
        cwd,
        env: {
          ...process.env,
          ...shellEnv.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })

      let output = ""

      // Initialize metadata with empty output
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      let binaryDetected = false
      const append = (chunk: Buffer) => {
        if (isBinaryBuffer(chunk)) {
          if (!binaryDetected) {
            binaryDetected = true
            output += "\n[binary output detected and stripped — " + chunk.length + " bytes]\n"
          }
          return
        }
        output += chunk.toString()
        ctx.metadata({
          metadata: {
            // truncate the metadata to avoid GIANT blobs of data (has nothing to do w/ what agent can access)
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            description: params.description,
          },
        })
      }

      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      let timedOut = false
      let aborted = false
      let exited = false

      const kill = () => Shell.killTree(proc, { exited: () => exited })

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100)

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
        }

        proc.once("exit", () => {
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })

      const resultMetadata: string[] = []

      if (timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push("User aborted the command")
      }

      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: proc.exitCode,
          description: params.description,
        },
        output,
      }
    },
  }
})
