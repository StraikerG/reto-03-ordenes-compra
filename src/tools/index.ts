import { z } from "zod/v4"
import { anexar, rutaOut } from "../lib/files"
import { fail } from "../lib/result"
import type { EspecHerramienta } from "../llm/adapter"
import type { Ctx, Herramienta } from "../types"
import * as oc from "./oc"

/** Registro de herramientas. El nombre que ve el modelo es `<archivo>_<export>`. */
export const herramientas: Record<string, Herramienta> = Object.fromEntries(
  Object.entries(oc).map(([nombre, h]) => [`oc_${nombre}`, h as Herramienta]),
)

/** Esquema JSON de cada herramienta para el proveedor LLM. */
export function especificaciones(): EspecHerramienta[] {
  return Object.entries(herramientas).map(([name, h]) => {
    const { $schema: _s, ...parameters } = z.toJSONSchema(z.object(h.args)) as Record<string, unknown>
    return { name, description: h.description, parameters }
  })
}

export interface EjecucionHerramienta {
  name: string
  args: unknown
  ok: boolean
  resultado: string
  resumen: string
}

function resumir(resultado: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(resultado) as { ok?: boolean; error?: string; data?: Record<string, unknown> }
    if (r.ok === false) return { ok: false, resumen: r.error ?? "error" }
    const d = r.data ?? {}
    const claves = Object.keys(d).slice(0, 6).join(", ")
    const extra = typeof d["numero_oc"] === "string" ? ` · OC ${d["numero_oc"]}` : typeof d["apta"] === "boolean" ? ` · apta=${d["apta"]}` : ""
    return { ok: true, resumen: `ok (${claves})${extra}` }
  } catch {
    return { ok: false, resumen: "respuesta no es JSON" }
  }
}

/**
 * Único punto de entrada para ejecutar una herramienta (agente y demo):
 * valida los argumentos con zod, ejecuta, y deja la traza en out/log.jsonl (CA4).
 */
export async function ejecutarHerramienta(name: string, input: unknown, ctx: Ctx): Promise<EjecucionHerramienta> {
  const h = herramientas[name]
  let resultado: string
  if (!h) {
    resultado = fail(`La herramienta "${name}" no existe.`)
  } else {
    const parsed = z.object(h.args).safeParse(input ?? {})
    resultado = parsed.success
      ? await h.execute(parsed.data as never, ctx)
      : fail(`Argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")}`)
  }
  const { ok, resumen } = resumir(resultado)
  const caso = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["caso"] : undefined
  await anexar(
    rutaOut(ctx.directory, "log.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), sessionId: ctx.sessionId, herramienta: name, caso: caso ?? null, ok, resumen }) + "\n",
  )
  return { name, args: input, ok, resultado, resumen }
}
