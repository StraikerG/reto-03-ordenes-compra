import {
  ErrorLlm,
  type EspecHerramienta,
  type LlamadaHerramienta,
  type LlmAdapter,
  type Mensaje,
  type RespuestaLlm,
} from "./adapter"

/**
 * Implementación para la API de mensajes de Anthropic usando `fetch` (sin SDK:
 * una dependencia menos y el mapeo de mensajes queda a la vista).
 * La clave se lee de ANTHROPIC_API_KEY y nunca se registra ni se devuelve.
 */

type Bloque =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }

interface MensajeAnthropic {
  role: "user" | "assistant"
  content: Bloque[]
}

function convertir(mensajes: Mensaje[]): MensajeAnthropic[] {
  const salida: MensajeAnthropic[] = []
  const agregarUsuario = (b: Bloque) => {
    const ultimo = salida[salida.length - 1]
    if (ultimo?.role === "user") ultimo.content.push(b)
    else salida.push({ role: "user", content: [b] })
  }
  for (const m of mensajes) {
    if (m.role === "user") agregarUsuario({ type: "text", text: m.content })
    else if (m.role === "tool") agregarUsuario({ type: "tool_result", tool_use_id: m.toolCallId, content: m.content })
    else if (m.role === "assistant") {
      const bloques: Bloque[] = []
      if (m.content) bloques.push({ type: "text", text: m.content })
      for (const c of m.toolCalls ?? []) bloques.push({ type: "tool_use", id: c.id, name: c.name, input: c.args })
      if (bloques.length) salida.push({ role: "assistant", content: bloques })
    }
  }
  return salida
}

interface RespuestaApi {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"
  readonly model: string
  readonly configurado: boolean
  private readonly clave: string
  private readonly timeoutMs: number

  constructor(env: Record<string, string | undefined> = process.env) {
    this.clave = env["ANTHROPIC_API_KEY"] ?? ""
    this.model = env["ANTHROPIC_MODEL"] ?? "claude-haiku-4-5-20251001"
    this.timeoutMs = Number(env["LLM_TIMEOUT_MS"] ?? 60000)
    this.configurado = this.clave !== ""
  }

  async enviar(mensajes: Mensaje[], herramientas: EspecHerramienta[]): Promise<RespuestaLlm> {
    if (!this.configurado) throw new ErrorLlm("El servidor no tiene configurada la clave del modelo (ANTHROPIC_API_KEY).")
    const system = mensajes.filter((m) => m.role === "system").map((m) => m.content).join("\n\n")
    const cuerpo = {
      model: this.model,
      max_tokens: 2048,
      system,
      messages: convertir(mensajes.filter((m) => m.role !== "system")),
      ...(herramientas.length
        ? { tools: herramientas.map((h) => ({ name: h.name, description: h.description, input_schema: h.parameters })) }
        : {}),
    }

    let res: Response
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": this.clave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      const agotado = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
      throw new ErrorLlm(agotado ? "El modelo no respondió a tiempo. Intente de nuevo." : "No se pudo contactar al proveedor del modelo.")
    }

    const json = (await res.json().catch(() => ({}))) as RespuestaApi
    if (!res.ok) {
      const motivo = res.status === 429 ? "El proveedor limitó las solicitudes; espere un momento." : (json.error?.message ?? `HTTP ${res.status}`)
      throw new ErrorLlm(`El proveedor del modelo devolvió un error: ${motivo}`)
    }

    const bloques = json.content ?? []
    const toolCalls: LlamadaHerramienta[] = bloques
      .filter((b) => b.type === "tool_use" && b.id && b.name)
      .map((b) => ({ id: b.id as string, name: b.name as string, args: b.input ?? {} }))
    return {
      content: bloques.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
      toolCalls,
      usage: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 },
    }
  }
}
