import path from "path"
import { lstat, readlink, realpath, open, constants } from "fs/promises"
import type { FileHandle } from "fs/promises"
import type { Tool } from "./tool"
import { Instance } from "../project/instance"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export type Resolved = {
  /** il path come richiesto, mostrato all'utente e nei messaggi */
  requested: string
  /** il path REALE: symlink risolti. Se diverso da `requested`, il confronto
   *  con il perimetro e la scrittura devono usare questo. */
  canonical: string
  /** true se `canonical` e' diverso da `requested`: la richiesta attraversa
   *  un symlink, e quindi la sua collocazione reale e' sconosciuta. */
  viaSymlink: boolean
}

/**
 * Risolve il path canonico di un file che si vuole scrivere.
 *
 * Il controllo del perimetro (`Instance.containsPath`) e la regola che concede
 * la scrittura (`allow("edit", ...)`) confrontano path LESSICALI: se la
 * directory del programma contiene un symlink verso un'altra directory, il
 * path richiesto resta sotto il programma mentre la scrittura finisce fuori.
 * Misurato il 2026-09-27 su `test/permission/symlink-perimeter-escape.test.ts`.
 *
 * Si risolve il path REALE, anche quando una parte non esiste ancora: sale
 * fino alla prima directory esistente, la risolve col `realpath` e riappone i
 * tratti mancanti (inesistenti per definizione, quindi non symlink). Serve
 * perche' il file da creare spesso non c'e' ancora, e `realpath` su un path
 * inesistente fallirebbe.
 *
 * Per il flusso bug bounty nessun symlink e' un caso legittimo: si restituisce
 * il path canonico e chi chiama scrive su quello, cosi' controllo e scrittura
 * riguardano lo stesso inode anche se un symlink compare in mezzo.
 */
export async function resolveWritePath(target: string): Promise<Resolved> {
  const absolute = path.resolve(target)
  // NON risolvere solo `dirname`: se un componente intermedio e' un symlink e
  // la directory finale non esiste ancora, `realpath(parent)` fallisce e il
  // fallback "il parent non esiste, `mkdir -p` creera' directory reali" e'
  // FALSO: `mkdir -p` segue il symlink e la scrittura finisce fuori.
  // Misurato il 2026-09-27: canary in `bcny-test/newdir/rubato.txt`.
  const canonical = await resolveDeepest(absolute)
  return { requested: absolute, canonical, viaSymlink: canonical !== absolute }
}

/**
 * Risolve il path REALE anche quando some parti non esistono ancora: sale dalla
 * destinazione fino alla prima directory esistente, la risolve col `realpath`
 * e riappone i tratti mancanti.
 *
 * Il caso NON ovvio e' il symlink DANNEGGIATO (punta a una destinazione che non
 * esiste ancora): `realpath` su quel cammino fallisce esattamente come su un
 * componente semplicemente inesistente, ma non sono la stessa cosa — il primo
 * e' un link che la scrittura seguira', il secondo no. Scambiali e il
 * controllo autorizza un path che `Bun.write` usa per uscire dal perimetro.
 * Misurato il 2026-09-27: canary in `other/created.txt` con contenuto
 * `ESCAPED`. Per questo, quando `realpath` fallisce, `lstat` distingue i due
 * casi e su un symlink si legge la destinazione con `readlink` per risolverla.
 */
async function resolveDeepest(absolute: string): Promise<string> {
  const missing: string[] = []
  let current = absolute
  // il limite evita cicli su permalink patologici; in pratica il cammino
  // risale fino alla radice in poche iterazioni
  for (let i = 0; i < 64; i++) {
    try {
      const real = await realpath(current)
      return missing.length ? path.join(real, ...missing.reverse()) : real
    } catch {
      // root filesystem: non c'e' piu' nulla da risolvere
      const parent = path.dirname(current)
      if (parent === current) return current

      // symlink DANNEGGIATO: esiste come link, ma la sua destinazione no.
      // Va seguito anche lui, altrimenti il perimetro lo giudica interno.
      try {
        const stats = await lstat(current)
        if (stats.isSymbolicLink()) {
          const dest = await readlink(current)
          // i tratti mancanti vanno rimessi DOPO la destinazione del link:
          // il path che l'agente ha chiesto e' link/figlio, quindi il figlio
          // viene dopo il punto in cui il link si risolve
          missing.unshift(...resolveRelativeLink(dest, path.dirname(current)))
          current = parent
          continue
        }
      } catch {
        // `lstat` fallisce: il componente e' davvero inesistente
      }

      missing.push(path.basename(current))
      current = parent
    }
  }
  return absolute
}

/** `readlink` puo' restituire un path relativo: va risolto contro la directory del link */
function resolveRelativeLink(dest: string, linkDir: string): string[] {
  const abs = path.isAbsolute(dest) ? dest : path.resolve(linkDir, dest)
  return [abs]
}


/**
 * Controlla il perimetro e RESTITUISCE il path canonico: il chiamante deve
 * scrivere su quello, mai sul path richiesto. Cosi' controllo e scrittura
 * riguardano lo stesso inode e non esiste finestra in cui un symlink possa
 * cambiarli.
 *
 * Restituire il path (invece di solo controllarlo) evita che ogni tool
 * ricalcoli la canonicalizzazione per conto proprio: una copia per tool e'
 * una porta che qualcuno puo' dimenticare di aggiornare.
 */
export async function assertExternalDirectory(
  ctx: Tool.Context,
  target?: string,
  options?: Options,
): Promise<string | undefined> {
  if (!target) return undefined

  // il confronto va fatto sul path REALE: con un symlink il path lessicale
  // resta dentro il perimetro mentre la scrittura finisce fuori
  const { canonical } = await resolveWritePath(target)
  if (options?.bypass) return canonical
  if (Instance.containsPath(canonical)) return canonical

  const resolvedTarget = canonical
  const kind = options?.kind ?? "file"
  const parentDir = kind === "directory" ? resolvedTarget : path.dirname(resolvedTarget)
  const glob = path.join(parentDir, "*")

  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: resolvedTarget,
      parentDir,
    },
  })

  return canonical
}

/**
 * Scrive in modo che il perimetro NON possa essere aggirato da una corsa.
 *
 * Il solo path canonico non basta: e' una STRINGA, e fra il momento in cui il
 * gate autorizza e quello in cui la syscall apre il file, un altro processo
 * puo' sostituire il path con un symlink verso l'esterno. Il gate autorizzava
 * `programs/bcny/race.txt`, la syscall ha aperto il file che quel nome
 * indicava DOPO, e la scrittura e' finita in `programs/bcny-test/`.
 * Misurato il 2026-09-28 su `test/permission/toctou-race.test.ts`:
 * con il gate `allow:1 deny:0` e il contenuto di un altro programma
 * sovrascritto; senza il gate lo stesso file restava intatto.
 *
 * La correzione e' aprire il file PRIMA e verificare che sia quello giusto:
 * `open()` restituisce un file descriptor, e il descriptor continua a
 * puntare allo stesso inode anche se il nome viene sostituito. Da qui in poi
 * nessuna corsa puo' spostare la destinazione: si scrive sull'handle.
 *
 * Il confronto e' fatto su dev+ino, non sul path: e' l'unico dato che
 * identifica il file davvero aperto. Il path torna identico a `fstat` solo se
 * nessuno l'ha spostato in mezzo.
 */
export async function openChecked(target: string, exists: boolean) {
  // `O_NOFOLLOW` e' la parte che chiude davvero la finestra. A userspace non
  // si puo': fra `open()` e la scrittura il nome puo' cambiare, e il perimetro
  // ha gia' concesso. Il kernel invece rifiuta il symlink all'ultimo
  // componente senza seguirlo (ELOOP). Verificato il 2026-09-28: file nuovo
  // OK, symlink ELOOP, contenuto della vittima intatto.
  //
  // Il flag vale SOLO per l'ultimo componente: una directory padre che e' un
  // symlink resta seguita. Per quello serve `assertExternalDirectory`, che
  // risolve il path canonico e viene comunque eseguito prima.
  //
  // L'handle si apre PRIMA del gate: aprirlo dopo lascia la corsa nella
  // finestra fra autorizzazione e open (misurato: aprendo dopo, l'escape si
  // riproduceva invariato).
  const flags = exists
    ? constants.O_RDWR | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW
  const handle = await open(target, flags)
  const st = await handle.stat()
  return { dev: st.dev, ino: st.ino, handle }
}

export async function writeChecked(
  opened: { dev: number; ino: number; handle: FileHandle },
  content: string,
) {
  try {
    // verifica che l'handle sia ancora quello giusto: se nel frattempo il nome
    // e' stato sostituito, l'handle punta al vecchio inode (quello interno) e
    // la scrittura ci va comunque. Il controllo serve a non scrivere in
    // silenzio su un file che non e' piu' quello autorizzato.
    const st = await opened.handle.stat()
    if (st.dev !== opened.dev || st.ino !== opened.ino) {
      throw new Error("perimetro: il file e' cambiato fra il controllo e la scrittura")
    }
    await opened.handle.truncate(0)
    await opened.handle.writeFile(content, "utf8")
  } finally {
    await opened.handle.close()
  }
}
