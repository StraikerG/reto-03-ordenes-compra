import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ErrorLlm, type LlmAdapter, type Mensaje } from "./llm/adapter"
import { ejecutarHerramienta, especificaciones } from "./tools"

/**
 * Ciclo del agente: prompt → modelo → herramientas → modelo → respuesta.
 *
 * - Tope de iteraciones por turno (CA1) y de tokens por sesión (costo).
 * - Confirmación humana (CA3): una OC con excepciones solo se crea si el turno
 *   ANTERIOR pidió confirmar ese caso; el servidor lo verifica, no el modelo.
 * - Cada llamada queda en el resultado del turno (para el front) y en out/log.jsonl (CA4).
 * - Un error del proveedor se convierte en mensaje claro; la sesión sigue viva (CA5).
 */

export interface ConfigAgente {
  directory: string
  maxIter: number
  maxTokensSesion: number
  /** Tope de tokens de todas las sesiones juntas desde que arrancó el proceso. */
  maxTokensGlobal: number
}

export function configDesdeEnv(directory: string, env: Record<string, string | undefined> = process.env): ConfigAgente {
  return {
    directory,
    maxIter: Number(env["MAX_ITER"] ?? 25),
    maxTokensSesion: Number(env["MAX_TOKENS_SESSION"] ?? 200000),
    maxTokensGlobal: Number(env["MAX_TOKENS_GLOBAL"] ?? 2000000),
  }
}

export interface LlamadaUi {
  name: string
  args: unknown
  ok: boolean
  resumen: string
}

export interface Turno {
  reply: string
  toolCalls: LlamadaUi[]
  needsConfirmation: boolean
  casosPendientes: string[]
}

export interface Sesion {
  id: string
  mensajes: Mensaje[]
  tokens: number
  /** Casos cuyo último intento quedó esperando confirmación. */
  pendientes: Set<string>
}

const sesiones = new Map<string, Sesion>()
let tokensGlobales = 0

export function obtenerSesion(id: string): Sesion {
  let s = sesiones.get(id)
  if (!s) {
    s = { id, mensajes: [], tokens: 0, pendientes: new Set() }
    sesiones.set(id, s)
  }
  return s
}

export function existeSesion(id: string): Sesion | undefined {
  return sesiones.get(id)
}

export async function cargarSystemPrompt(directory: string): Promise<string> {
  const [comportamiento, conocimiento] = await Promise.all([
    readFile(join(directory, "agent", "prompt.md"), "utf8"),
    readFile(join(directory, "src", "knowledge", "ordenes-compra.md"), "utf8"),
  ])
  return `${comportamiento}\n\n---\n\n${conocimiento}`
}

interface RespuestaHerramienta {
  ok?: boolean
  codigo?: string
  data?: {
    apta?: boolean
    confirmaciones?: unknown[]
    numero_oc?: string
    fecha?: string | null
    idempotente?: boolean
    retroactiva?: boolean
  }
}

function leerRespuesta(texto: string): RespuestaHerramienta {
  try {
    return JSON.parse(texto) as RespuestaHerramienta
  } catch {
    return {}
  }
}

function casoDe(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null
  const c = (args as Record<string, unknown>)["caso"]
  return typeof c === "string" ? c : null
}

function contar(sesion: Sesion, uso: { input: number; output: number }): void {
  const n = uso.input + uso.output
  sesion.tokens += n
  tokensGlobales += n
}

interface OcCreada {
  caso: string
  numero_oc?: string
  fecha?: string | null
  idempotente?: boolean
  retroactiva?: boolean
}

function resumenCreadas(creadas: OcCreada[]): string {
  return creadas
    .map((c) => {
      const numero = c.numero_oc ?? "sin número reportado"
      if (c.idempotente) return `✅ No se creó una orden duplicada. La OC **${numero}** ya existía para el caso **${c.caso}**.`
      return (
        `✅ OC creada exitosamente.\n\n` +
        `- **Número de OC:** ${numero}\n` +
        `- **Fecha:** ${c.fecha ?? "sin fecha reportada"}\n` +
        `- **Caso:** ${c.caso}\n` +
        `- **Retroactiva:** ${c.retroactiva ? "Sí" : "No"}\n\n` +
        "La OC quedó registrada en el SAP simulado y en out/control.csv."
      )
    })
    .join("\n\n---\n\n")
}

export async function chat(
  cfg: ConfigAgente,
  llm: LlmAdapter,
  sessionId: string,
  texto: string,
): Promise<Turno> {
  const sesion = obtenerSesion(sessionId)
  const llamadas: LlamadaUi[] = []
  const terminar = (reply: string): Turno => ({
    reply,
    toolCalls: llamadas,
    needsConfirmation: sesion.pendientes.size > 0,
    casosPendientes: [...sesion.pendientes],
  })

  if (sesion.tokens >= cfg.maxTokensSesion) {
    return terminar("Esta sesión alcanzó su límite de uso. Abra una conversación nueva para continuar.")
  }
  if (tokensGlobales >= cfg.maxTokensGlobal) {
    return terminar("El servicio alcanzó su límite de uso por ahora. Intente más tarde.")
  }

  // Qué casos esperaban confirmación al empezar este turno: solo esos pueden confirmarse ahora.
  const confirmables = new Set(sesion.pendientes)
  sesion.pendientes = new Set()
  const ctx = {
    directory: cfg.directory,
    sessionId,
    usuario: "analista (chat)",
    puedeConfirmar: (caso: string) => confirmables.has(caso),
  }

  if (sesion.mensajes.length === 0) {
    sesion.mensajes.push({ role: "system", content: await cargarSystemPrompt(cfg.directory) })
  }
  sesion.mensajes.push({ role: "user", content: texto })
  const specs = especificaciones()

  try {
    for (let i = 0; i < cfg.maxIter; i++) {
      const r = await llm.enviar(sesion.mensajes, specs)
      contar(sesion, r.usage)
      sesion.mensajes.push({ role: "assistant", content: r.content, toolCalls: r.toolCalls })
      if (r.toolCalls.length === 0) return terminar(r.content)

      const creadas: OcCreada[] = []
      for (const llamada of r.toolCalls) {
        const e = await ejecutarHerramienta(llamada.name, llamada.args, ctx)
        llamadas.push({ name: e.name, args: e.args, ok: e.ok, resumen: e.resumen })
        sesion.mensajes.push({ role: "tool", toolCallId: llamada.id, name: llamada.name, content: e.resultado })

        const caso = casoDe(llamada.args)
        const resp = leerRespuesta(e.resultado)
        if (caso && resp.codigo === "REQUIERE_CONFIRMACION") sesion.pendientes.add(caso)
        if (caso && llamada.name === "oc_validar" && resp.data?.apta && (resp.data.confirmaciones?.length ?? 0) > 0) {
          sesion.pendientes.add(caso)
        }

        if (caso && llamada.name === "oc_crear" && resp.ok) {
          sesion.pendientes.delete(caso)
          creadas.push({ caso, ...resp.data })
        }
      }

      // Resultado terminal: tras crear una OC no se vuelve a consultar al LLM (así no repite una
      // confirmación ya consumida). Se decide DESPUÉS de ejecutar todas las llamadas de esta
      // respuesta: si se saliera antes, las llamadas restantes quedarían sin resultado en el
      // historial y el proveedor rechazaría el siguiente mensaje de la sesión.
      if (creadas.length > 0) return terminar(resumenCreadas(creadas))
    }

    // CA1: tope alcanzado → una última llamada sin herramientas para resumir lo hecho y lo pendiente.
    sesion.mensajes.push({
      role: "user",
      content: "[sistema] Se alcanzó el máximo de pasos del turno. Resume lo que lograste y lo que falta, sin llamar herramientas.",
    })
    const cierre = await llm.enviar(sesion.mensajes, [])
    contar(sesion, cierre.usage)
    sesion.mensajes.push({ role: "assistant", content: cierre.content })
    return terminar(cierre.content)
  } catch (e) {
    // Un fallo no debe quitarle a la persona la posibilidad de confirmar en el siguiente intento.
    for (const c of confirmables) sesion.pendientes.add(c)
    const msg = e instanceof ErrorLlm ? e.message : "Ocurrió un error inesperado al procesar el mensaje."
    return terminar(`⚠️ ${msg}`)
  }
}
