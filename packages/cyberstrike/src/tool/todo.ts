import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"
import { BountyState } from "../session/bounty-state"
import { Instance } from "../project/instance"

// Gate del progetto-hunting: "leggere lo stato prima dei TODO" è imposto
// MECCANICAMENTE, non con un'istruzione di prompt (che salta se il contesto è
// lungo o il modello è debole). Il tool manca all'agente finché lo stato non è
// stato caricato in questa sessione — vedi ticket stato-progetto.
//
// Il flag vive in Instance.state (per-sessione, azzerato al riavvio): la
// sessione di hunting lo setta caricando lo stato. Fuori da una sessione di
// hunting (progetti normali) non c'è confine e il gate non si applica: la
// directory di lavoro non è un progetto bounty.
function gate(dir: string, sessionID: string): string | undefined {
  if (!isHuntingProject(dir)) return undefined
  if (BountyState.loaded(sessionID)) return undefined
  return (
    "Questo è un progetto di bug bounty: prima di pianificare devi caricare lo stato attuale, " +
    "per non ripetere lavoro già fatto. Il tool per farlo è `bounty_status`. " +
    "Non è una raccomandazione: finché non lo chiami, todowrite non è disponibile."
  )
}

/** Errore del gate: il tool non deve poter "riuscire" senza stato. */
export class BountyStateNotLoaded extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BountyStateNotLoaded"
  }
}

/** Un progetto di hunting è una directory che contiene (o deve contenere) uno stato bounty. */
function isHuntingProject(dir: string): boolean {
  try {
    return BountyState.isHuntingDir(dir)
  } catch {
    return false
  }
}

export const TodoWriteTool = Tool.define<
  z.ZodObject<{ todos: z.ZodArray<z.ZodObject<typeof Todo.Info.shape>> }>,
  { todos: Todo.Info[]; blockedBy?: string }
>("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const blocked = gate(Instance.directory, ctx.sessionID)
    if (blocked) {
      // Lancia, non ritorna un output di "blocco": un risultato che il tool
      // dichiara riuscito (title + metadata) verrebbe contato come `successful`
      // da `batch`, e l'agente non vedrebbe nulla di anormale. Un errore è
      // l'unica forma che il gate può prendere per essere un gate.
      throw new BountyStateNotLoaded(blocked)
    }

    const activeCount = params.todos.filter((x) => x.status === "pending" || x.status === "in_progress").length
    if (activeCount > 25) {
      return {
        title: "error",
        output:
          "Cannot have more than 25 active (pending/in_progress) todos. Consolidate related items or complete/cancel existing ones first.",
        metadata: {
          todos: params.todos,
        },
      }
    }

    await Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
    })
    return {
      title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,
      output: JSON.stringify(params.todos, null, 2),
      metadata: {
        todos: params.todos,
      },
    }
  },
})

export const TodoReadTool = Tool.define("todoread", {
  description: "Use this tool to read your todo list",
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "todoread",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const todos = await Todo.get(ctx.sessionID)
    const active = todos.filter((x) => x.status === "pending" || x.status === "in_progress")
    const doneCount = todos.length - active.length
    const output =
      doneCount > 0
        ? JSON.stringify(active, null, 2) + `\n\n(${doneCount} completed/cancelled items hidden)`
        : JSON.stringify(active, null, 2)
    return {
      title: `${active.length} todos`,
      metadata: {
        todos,
      },
      output,
    }
  },
})
