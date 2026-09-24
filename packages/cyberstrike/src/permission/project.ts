/**
 * Perimetro di scrittura per i progetti di bug bounty.
 *
 * Obiettivo: l'agente legge ovunque, ma scrive SOLO dentro la directory del
 * progetto. Il contenimento è imposto meccanicamente dal ruleset di permessi
 * (non da Instance.worktree, che è la radice del repo git e non la directory
 * di lavoro: senza `.git` diventa "/" e la sandbox si disattiva del tutto).
 *
 * Il ruleset prodotto viene passato a `session.createNext({ permission })`.
 * Il ruleset attivo è `merge(agent.permission, session.permission)` con la
 * sessione che vince (evaluate() usa findLast), quindi vale per qualunque
 * agente usato nella sessione.
 */

import path from "path"
import { Filesystem } from "@/util/filesystem"
import type { PermissionNext } from "./next"

/**
 * Comandi considerati di sola lettura: nessun attrito.
 * Sono il grosso dell'uso reale durante un hunting, quindi un `ask` su questi
 * renderebbe il perimetro inutilizzabile in pratica.
 *
 * NOTA: un comando presente anche in WRITE_COMMANDS (curl, sed, tar) viene
 * classificato da `classify()` come scrittura: la lista read-only descrive
 * l'uso tipico, non l'unico.
 *
 * ATTENZIONE nell'aggiungere comandi: un comando va qui solo se non esiste una
 * sua invocazione che scrive. `find` NON è in elenco perché `find / -delete`
 * cancella file e `-exec` esegue qualunque cosa.
 */
export const READ_ONLY = new Set([
  "ls",
  "cat",
  "grep",
  "rg",
  "fd",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "which",
  "whereis",
  "type",
  "echo",
  "printf",
  "pwd",
  "whoami",
  "id",
  "uname",
  "env",
  "printenv",
  "date",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "sort",
  "uniq",
  "cut",
  "tr",
  "awk",
  "jq",
  "yq",
  "diff",
  "tree",
  "du",
  "df",
  "less",
  "more",
  "xxd",
  "hexdump",
  "strings",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "base64",
  "dig",
  "host",
  "nslookup",
  "whois",
  "ping",
  "traceroute",
  "openssl",
  "ssh-keygen",
  "git",
  "true",
  "false",
  "test",
  "sleep",
])

/**
 * Comandi che scrivono su un path passato come argomento.
 *
 * `writeFlags` elenca i flag che introducono ESPLICITAMENTE un path di
 * scrittura (`-o /tmp/x`), il cui valore è l'argomento successivo.
 * `inPlaceFlags` elenca i flag che ATTIVANO la scrittura ma NON introducono un
 * path (`sed -i`, che scrive sul file già passato come argomento): il file è
 * un argomento posizionale, e trattare il flag come se introducesse un path
 * produrrebbe un candidato fantasma (l'espressione di sed).
 * `keyValueFlags` elenca i flag `chiave=valore` in cui il valore è un path
 * (`dd of=/tmp/x`).
 *
 * Gli argomenti posizionali sono sempre candidati (esclusi i flag).
 */
export const WRITE_COMMANDS: Record<
  string,
  { writeFlags?: string[]; inPlaceFlags?: string[]; keyValueFlags?: string[] }
> = {
  cd: {},
  rm: {},
  rmdir: {},
  cp: {},
  mv: {},
  install: {},
  mkdir: {},
  touch: {},
  chmod: {},
  chown: {},
  chgrp: {},
  ln: {},
  tee: {},
  truncate: {},
  shred: {},
  dd: { keyValueFlags: ["of="] },
  sed: { inPlaceFlags: ["-i", "--in-place"] },
  curl: { writeFlags: ["-o", "--output"] },
  wget: { writeFlags: ["-O", "--output-document"] },
  tar: { writeFlags: ["-f", "--file", "-C", "--directory"] },
  unzip: { writeFlags: ["-d"] },
  zip: {},
  gzip: {},
  gunzip: {},
  rsync: {},
  patch: { writeFlags: ["-i", "--input"] },
}

/**
 * Comandi la cui scrittura non è ispezionabile staticamente
 * (`python3 -c "open('/tmp/x','w')"`): il path è dentro una stringa, nessuna
 * analisi sintattica lo trova. Non si tenta di rilevare il path: si mette in
 * `ask` il comando, e l'utente decide (con facoltà di approvare in blocco).
 *
 * `bash`/`sh`/`eval` sono qui perché `bash -c '...'` reintroduce qualunque
 * scrittura in forma opaca: è il vettore di elusione più banale.
 */
export const OPAQUE = new Set([
  "python",
  "python2",
  "python3",
  "node",
  "deno",
  "bun",
  "bunx",
  "npx",
  "perl",
  "ruby",
  "php",
  "lua",
  "Rscript",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "eval",
  "exec",
  "source",
  ".",
  "go",
  "java",
  "javac",
  "dotnet",
  "sqlite3",
  "psql",
  "mysql",
  "redis-cli",
  "docker",
  "podman",
  "systemctl",
  "crontab",
  "apt",
  "apt-get",
  "dnf",
  "yum",
  "pacman",
  "snap",
  "pip",
  "pip3",
  "npm",
  "yarn",
  "pnpm",
  "gem",
  "cargo",
  "make",
  "cmake",
  "gcc",
  "g++",
  "clang",
  "rustc",
  "sudo",
  "su",
  "doas",
])

/**
 * Classe di un comando, secondo il perimetro:
 *   read-only -> nessun controllo
 *   write     -> il path va risolto e confrontato col perimetro
 *   opaque    -> non ispezionabile, va in conferma
 *   unknown   -> non classificato, va in conferma
 */
export type CommandClass = "read-only" | "write" | "opaque" | "unknown"

/**
 * Classifica un comando. La precedenza è OPAQUE > WRITE > READ_ONLY, perché un
 * comando presente in più liste (curl con -o, sed con -i) va trattato nel modo
 * più restrittivo: la sua invocazione PUÒ scrivere.
 */
export function classify(name: string | undefined): CommandClass {
  if (!name) return "unknown"
  if (OPAQUE.has(name)) return "opaque"
  if (WRITE_COMMANDS[name] !== undefined) return "write"
  if (READ_ONLY.has(name)) return "read-only"
  return "unknown"
}

/**
 * Estrae i path su cui il comando scrive, dalla lista di argomenti.
 * Gestisce quattro forme:
 *   - path posizionale               (`rm /tmp/x`, `cp a b`, il file di `sed -i`)
 *   - flag che introduce un path     (`-o /tmp/x`, `--output /tmp/x`)
 *   - flag `chiave=valore` con path  (`of=/tmp/x`)
 *   - flag che attiva la scrittura   (`sed -i`) -> ignorato, non introduce path
 * I flag di sola lettura NON sono candidati: senza questo, un
 * `dd if=/dev/zero of=/tmp/x` produrrebbe un candidato inesistente.
 */
export function pathCandidates(name: string, args: string[]): string[] {
  const spec = WRITE_COMMANDS[name]
  const candidates: string[] = []
  if (!spec) return candidates

  const writeFlags = spec.writeFlags ?? []
  const inPlaceFlags = spec.inPlaceFlags ?? []
  const keyValueFlags = spec.keyValueFlags ?? []

  const isPathFlag = (arg: string) => writeFlags.some((f) => arg === f)
  const isKeyValuePathFlag = (arg: string) => keyValueFlags.some((f) => arg.startsWith(f))
  const isInPlaceFlag = (arg: string) => inPlaceFlags.some((f) => arg === f)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (isKeyValuePathFlag(arg)) {
      const value = arg.slice(arg.indexOf("=") + 1)
      if (value) candidates.push(value)
      continue
    }
    if (isPathFlag(arg)) {
      const next = args[i + 1]
      if (next && !next.startsWith("-")) {
        candidates.push(next)
        i++ // l'argomento è stato consumato dal flag: non va raccolto di nuovo
      }
      continue
    }
    // `sed -i`: attiva la scrittura sul file posizionale, non introduce un path
    if (isInPlaceFlag(arg)) continue
    // qualunque altro `chiave=valore` è un flag con valore, non un path
    if (/^[a-zA-Z_][a-zA-Z0-9_-]*=/.test(arg)) continue
    // flag booleani
    if (arg.startsWith("-") || (name === "chmod" && arg.startsWith("+"))) continue
    candidates.push(arg)
  }
  return candidates
}

export namespace ProjectPerimeter {
  type Rule = PermissionNext.Rule
  type Ruleset = PermissionNext.Ruleset

  export type Risk = "none" | "no-repo" | "project-in-repo" | "project-is-repo-root"

  export type Diagnosis = {
    /** directory del progetto, risolta e normalizzata */
    projectDir: string
    /** radice del repo git che contiene il progetto (se esiste) */
    worktree: string | undefined
    risk: Risk
    /** messaggio da mostrare all'avvio della sessione */
    warning: string | undefined
  }

  /**
   * Classifica il rapporto tra la directory del progetto e il repo git.
   *
   * Conta perché il codice esistente (`Instance.containsPath`, i tool write/
   * edit) calcola i pattern RELATIVI alla radice del repo. Con
   * `projectDir === worktree` il path relativo di un file interno è "state.json"
   * e quello di un file esterno è "../../../../etc/passwd": entrambi matchano
   * il pattern `*` (che diventa `.*` senza ancoraggio di directory), quindi il
   * perimetro si apre. Il caso va RIFIUTATO.
   */
  export async function diagnose(projectDir: string): Promise<Diagnosis> {
    const resolved = path.resolve(projectDir)

    const matches = Filesystem.up({ targets: [".git"], start: resolved })
    const dotgit = await matches.next().then((x) => x.value)
    await matches.return()

    if (!dotgit) {
      return {
        projectDir: resolved,
        worktree: undefined,
        risk: "no-repo",
        warning: undefined,
      }
    }

    const worktree = path.dirname(dotgit)

    if (path.resolve(worktree) === resolved) {
      return {
        projectDir: resolved,
        worktree,
        risk: "project-is-repo-root",
        warning:
          `La directory del progetto è la radice del repo git (${worktree}). ` +
          `In questa configurazione il perimetro di scrittura NON è affidabile: ` +
          `i tool calcolano i path relativi alla radice del repo, e un file ` +
          `interno e uno esterno producono pattern indistinguibili. ` +
          `Usare un progetto fuori da un repo, o in una sottocartella del repo.`,
      }
    }

    return {
      projectDir: resolved,
      worktree,
      risk: "project-in-repo",
      warning:
        `La directory del progetto è dentro il repo git ${worktree}. ` +
        `Il perimetro resta attivo, ma il controllo "external_directory" non ` +
        `farà da campanello: per quel controllo qualunque punto del repo è ` +
        `"interno". Le scritture fuori progetto saranno rifiutate senza una ` +
        `richiesta di conferma intermedia.`,
    }
  }

  /** true se la directory del progetto può ospitare un perimetro affidabile */
  export function isSafe(d: Diagnosis): boolean {
    return d.risk !== "project-is-repo-root"
  }

  /**
   * Costruisce il ruleset che confina la scrittura alla directory del progetto.
   *
   * `worktree` è la radice del repo git rilevata da `diagnose()`; serve per
   * produrre la forma RELATIVA del pattern (i tool write/edit mandano
   * `path.relative(Instance.worktree, filepath)`). Senza `.git` il worktree è
   * "/" e la forma relativa diventa il path assoluto senza lo slash iniziale.
   *
   * Entrambe le forme sono necessarie: nessuna delle due copre l'altra, perché
   * i tool write/edit usano quella relativa e `external-directory` quella
   * assoluta.
   */
  export function buildProjectRuleset(projectDir: string, worktree: string | undefined): Ruleset {
    const dir = path.resolve(projectDir)
    const rel = path.relative(worktree ?? "/", dir)

    const allowPatterns = [rel + "/*", dir + "/*"]

    return [
      { permission: "edit", pattern: "*", action: "deny" },
      ...allowPatterns.map((pattern): Rule => ({ permission: "edit", pattern, action: "allow" })),
      { permission: "external_directory", pattern: "*", action: "deny" },
      ...allowPatterns.map((pattern): Rule => ({ permission: "external_directory", pattern, action: "allow" })),
      // bash: la classificazione dei comandi è fatta in bash.ts, che manda
      // pattern testuali (non path). Un deny secco bloccherebbe anche il
      // riconoscimento, quindi resta `ask` — è il gate di classe C/D.
      { permission: "bash", pattern: "*", action: "ask" },
      // comandi a scrittura opaca o con path non risolvibile ($VAR):
      // non decidibili -> conferma esplicita dedicata
      { permission: "bash_unresolved", pattern: "*", action: "ask" },
      // lettura libera: nessuna regola restrittiva
      { permission: "read", pattern: "*", action: "allow" },
    ]
  }
}