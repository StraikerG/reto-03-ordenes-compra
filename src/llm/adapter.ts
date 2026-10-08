/**
 * Interfaz propia del proveedor LLM. El ciclo del agente solo conoce esto:
 * cambiar de proveedor = escribir otro archivo que implemente `LlmAdapter`.
 */

export interface LlamadaHerramienta {
  id: string
  name: string
  args: Record<string, unknown>
  thoughtSignature?: string

}

export type Mensaje =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlamadaHerramienta[] }
  | { role: "tool"; toolCallId: string; name: string; content: string }

export interface EspecHerramienta {
  name: string
  description: string
  /** JSON Schema (objeto) de los argumentos. */
  parameters: Record<string, unknown>
}

export interface RespuestaLlm {
  content: string
  toolCalls: LlamadaHerramienta[]
  usage: { input: number; output: number }
}

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  /** false si falta la clave: el servidor arranca y responde con un mensaje claro. */
  readonly configurado: boolean
  enviar(mensajes: Mensaje[], herramientas: EspecHerramienta[]): Promise<RespuestaLlm>
}

/** Error del proveedor con mensaje apto para el usuario (CA5). */
export class ErrorLlm extends Error {}
