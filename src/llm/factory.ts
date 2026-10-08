import type { LlmAdapter } from "./adapter"
import { AnthropicAdapter } from "./anthropic"
import { GeminiAdapter } from "./gemini"

export function crearLlm( env: Record<string, string | undefined> = process.env, ): LlmAdapter {
  const provider = (
    env["LLM_PROVIDER"] ??
    (env["GEMINI_API_KEY"] ? "gemini" : "anthropic")
  )
    .trim()
    .toLowerCase()

  if (provider === "gemini") {
    return new GeminiAdapter(env)
  }

  if (provider === "anthropic") {
    return new AnthropicAdapter(env)
  }

  throw new Error(
    `LLM_PROVIDER inválido: "${provider}". Use "gemini" o "anthropic".`,
  )
}