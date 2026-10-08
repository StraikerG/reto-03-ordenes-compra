import {
  ErrorLlm,
  type EspecHerramienta,
  type LlamadaHerramienta,
  type LlmAdapter,
  type Mensaje,
  type RespuestaLlm,
} from "./adapter"

type ParteGemini =
  | {
      text: string
      thoughtSignature?: string
    }
  | {
      functionCall: {
        id?: string
        name: string
        args: Record<string, unknown>
      }
      thoughtSignature?: string
    }
  | {
      functionResponse: {
        id?: string
        name: string
        response: Record<string, unknown>
      }
    }

interface ContenidoGemini {
  role: "user" | "model"
  parts: ParteGemini[]
}

interface RespuestaGemini {
  candidates?: Array<{
    content?: {
      role?: "model"
      parts?: ParteGemini[]
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
  }
  error?: {
    message?: string
  }
}

function esTexto( parte: ParteGemini, ): parte is { text: string; thoughtSignature?: string } {
  return "text" in parte
}

function esLlamadaFuncion( parte: ParteGemini, ): parte is {
  functionCall: {
    id?: string
    name: string
    args: Record<string, unknown>
  }
  thoughtSignature?: string
} {
  return "functionCall" in parte
}

/** * Gemini exige que functionResponse.response sea un objeto JSON. */
function respuestaComoObjeto(texto: string): Record<string, unknown> {
  try {
    const valor = JSON.parse(texto) as unknown

    if (typeof valor === "object" && valor !== null && !Array.isArray(valor)) {
      return valor as Record<string, unknown>
    }
  } catch {
    // La salida de herramienta no siempre es JSON.
  }

  return { result: texto }
}

/** * Gemini acepta un subconjunto de JSON Schema en los parámetros de * function declarations. Zod genera propiedades estándar que Gemini * rechaza, como additionalProperties y $schema. */
function normalizarParametrosGemini( valor: unknown, ): Record<string, unknown> {
  const limpiar = (actual: unknown): unknown => {
    if (Array.isArray(actual)) {
      return actual.map(limpiar)
    }

    if (typeof actual !== "object" || actual === null) {
      return actual
    }

    const resultado: Record<string, unknown> = {}

    for (const [clave, contenido] of Object.entries(actual)) {
      if (
        clave === "additionalProperties" ||
        clave === "$schema" ||
        clave === "$defs" ||
        clave === "definitions"
      ) {
        continue
      }

      resultado[clave] = limpiar(contenido)
    }

    return resultado
  }

  return limpiar(valor) as Record<string, unknown>
}

/** * Convierte el historial interno al formato REST de Gemini. * * Importante: * - Las respuestas de herramientas se envían como role=user. * - Las thoughtSignature recibidas en functionCall se reenvían intactas. * - Gemini 3 exige esas firmas para continuar ciclos de herramientas. */
function convertirMensajes(mensajes: Mensaje[]): ContenidoGemini[] {
  const salida: ContenidoGemini[] = []

  const agregarUsuario = (parte: ParteGemini): void => {
    const ultimo = salida[salida.length - 1]

    if (ultimo?.role === "user") {
      ultimo.parts.push(parte)
      return
    }

    salida.push({
      role: "user",
      parts: [parte],
    })
  }

  for (const mensaje of mensajes) {
    if (mensaje.role === "system") {
      continue
    }

    if (mensaje.role === "user") {
      agregarUsuario({
        text: mensaje.content,
      })
      continue
    }

    if (mensaje.role === "assistant") {
      const parts: ParteGemini[] = []

      if (mensaje.content) {
        parts.push({
          text: mensaje.content,
        })
      }

      for (const llamada of mensaje.toolCalls ?? []) {
        parts.push({
          functionCall: {
            id: llamada.id,
            name: llamada.name,
            args: llamada.args,
          },
          ...(llamada.thoughtSignature
            ? { thoughtSignature: llamada.thoughtSignature }
            : {}),
        })
      }

      if (parts.length > 0) {
        salida.push({
          role: "model",
          parts,
        })
      }

      continue
    }

    agregarUsuario({
      functionResponse: {
        id: mensaje.toolCallId,
        name: mensaje.name,
        response: respuestaComoObjeto(mensaje.content),
      },
    })
  }

  return salida
}

/** * Adaptador REST nativo para Gemini. * * La clave se obtiene exclusivamente desde GEMINI_API_KEY en el backend. * No se expone al navegador, logs, repositorio ni respuestas HTTP. */
export class GeminiAdapter implements LlmAdapter {
  readonly provider = "gemini"
  readonly model: string
  readonly configurado: boolean

  private readonly clave: string
  private readonly timeoutMs: number

  constructor(env: Record<string, string | undefined> = process.env) {
    this.clave = env["GEMINI_API_KEY"] ?? ""
    this.model = env["GEMINI_MODEL"] ?? "gemini-3.6-flash"
    this.timeoutMs = Number(env["LLM_TIMEOUT_MS"] ?? 60000)
    this.configurado = this.clave !== ""
  }

  async enviar(
    mensajes: Mensaje[],
    herramientas: EspecHerramienta[],
  ): Promise<RespuestaLlm> {
    if (!this.configurado) {
      throw new ErrorLlm(
        "El servidor no tiene configurada la clave del modelo (GEMINI_API_KEY).",
      )
    }

    const systemInstruction = mensajes
      .filter((mensaje) => mensaje.role === "system")
      .map((mensaje) => mensaje.content)
      .join("\n\n")

    const model = this.model.replace(/^models\//, "")

    const cuerpo = {
      contents: convertirMensajes(mensajes),

      ...(systemInstruction
        ? {
            systemInstruction: {
              parts: [{ text: systemInstruction }],
            },
          }
        : {}),

      ...(herramientas.length > 0
        ? {
            tools: [
              {
                functionDeclarations: herramientas.map((herramienta) => ({
                  name: herramienta.name,
                  description: herramienta.description,
                  parameters: normalizarParametrosGemini(
                    herramienta.parameters,
                  ),
                })),
              },
            ],
          }
        : {}),

      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.2,
      },
    }

    let respuesta: Response

    try {
      respuesta = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.clave,
          },
          body: JSON.stringify(cuerpo),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      )
    } catch (error) {
      const agotado =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")

      throw new ErrorLlm(
        agotado
          ? "El modelo no respondió a tiempo. Intente de nuevo."
          : "No se pudo contactar al proveedor del modelo.",
      )
    }

    const json = (await respuesta
      .json()
      .catch(() => ({}))) as RespuestaGemini

    if (!respuesta.ok) {
      const motivo =
        respuesta.status === 429
          ? "El proveedor limitó las solicitudes; espere un momento."
          : json.error?.message ?? `HTTP ${respuesta.status}`

      throw new ErrorLlm(
        `El proveedor del modelo devolvió un error: ${motivo}`,
      )
    }

    const candidate = json.candidates?.[0]

    if (!candidate) {
      throw new ErrorLlm(
        "Gemini no devolvió una respuesta utilizable para esta solicitud.",
      )
    }

    const partes = candidate.content?.parts ?? []

    const toolCalls: LlamadaHerramienta[] = partes
      .filter(esLlamadaFuncion)
      .map((parte, indice) => ({
        id: parte.functionCall.id ?? `gemini-call-${indice}`,
        name: parte.functionCall.name,
        args: parte.functionCall.args ?? {},
        ...(parte.thoughtSignature
          ? { thoughtSignature: parte.thoughtSignature }
          : {}),
      }))

    const content = partes
      .filter(esTexto)
      .map((parte) => parte.text)
      .join("")

    return {
      content,
      toolCalls,
      usage: {
        input: json.usageMetadata?.promptTokenCount ?? 0,
        output: json.usageMetadata?.candidatesTokenCount ?? 0,
      },
    }
  }
}