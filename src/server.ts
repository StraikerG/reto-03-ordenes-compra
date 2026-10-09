import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chat, configDesdeEnv, existeSesion } from "./agent"
import type { LlmAdapter } from "./llm/adapter"
import { crearLlm } from "./llm/factory"

/**
 * API HTTP del chat.
 *   POST /api/chat          { sessionId, message } → { reply, toolCalls[], needsConfirmation }
 *   GET  /api/sessions/:id  historial de la sesión
 *   GET  /api/health        { ok, provider, model, configured } (sin claves)
 */

const MAX_CUERPO = 8_000
const MAX_MENSAJE = 2_000
const SESION_RE = /^[A-Za-z0-9_-]{8,64}$/

function json(res: ServerResponse, status: number, cuerpo: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage): Promise<string> {
  const partes: Buffer[] = []
  let total = 0
  for await (const parte of req) {
    const b = parte as Buffer
    total += b.length
    if (total > MAX_CUERPO) throw new Error("cuerpo demasiado grande")
    partes.push(b)
  }
  return Buffer.concat(partes).toString("utf8")
}

/** Límite simple por IP (ventana de 1 minuto) para que nadie gaste la clave sin tope. */
function crearLimitador(maxPorMinuto: number) {
  const ventanas = new Map<string, { desde: number; n: number }>()
  return (ip: string): boolean => {
    const ahora = Date.now()
    const v = ventanas.get(ip)
    if (!v || ahora - v.desde > 60_000) {
      ventanas.set(ip, { desde: ahora, n: 1 })
      return true
    }
    v.n++
    return v.n <= maxPorMinuto
  }
}

export function crearServidor(directory: string, llm: LlmAdapter, env: Record<string, string | undefined> = process.env) {
  const cfg = configDesdeEnv(directory, env)
  const permitido = crearLimitador(Number(env["RATE_LIMIT_PER_MIN"] ?? 30))
  const colas = new Map<string, Promise<unknown>>()

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost")
      const ip = req.socket.remoteAddress ?? "?"

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = await readFile(join(directory, "web", "index.html"), "utf8")
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        res.end(html)
        return
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        json(res, 200, { ok: true, provider: llm.provider, model: llm.model, configured: llm.configurado })
        return
      }

      const m = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
      if (req.method === "GET" && m?.[1]) {
        const s = SESION_RE.test(m[1]) ? existeSesion(m[1]) : undefined
        if (!s) return json(res, 404, { ok: false, error: "Sesión no encontrada." })
        const historial = s.mensajes
          .filter((x) => x.role !== "system")
          .map((x) =>
            x.role === "tool"
              ? { role: "tool", name: x.name, content: x.content }
              : x.role === "assistant"
                ? { role: "assistant", content: x.content, toolCalls: (x.toolCalls ?? []).map((c) => ({ name: c.name, args: c.args })) }
                : { role: x.role, content: x.content },
          )
        return json(res, 200, { ok: true, sessionId: s.id, tokens: s.tokens, pendientes: [...s.pendientes], historial })
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        if (!permitido(ip)) return json(res, 429, { ok: false, error: "Demasiadas solicitudes. Espere un minuto." })
        let datos: { sessionId?: unknown; message?: unknown }
        try {
          datos = JSON.parse(await leerCuerpo(req)) as typeof datos
        } catch {
          return json(res, 400, { ok: false, error: "Solicitud inválida: se esperaba JSON de hasta 8 KB." })
        }
        const sessionId = typeof datos.sessionId === "string" ? datos.sessionId : ""
        const message = typeof datos.message === "string" ? datos.message.trim() : ""
        if (!SESION_RE.test(sessionId)) return json(res, 400, { ok: false, error: "sessionId inválido (8–64 caracteres: letras, números, - y _)." })
        if (!message) return json(res, 400, { ok: false, error: "El mensaje está vacío." })
        if (message.length > MAX_MENSAJE) return json(res, 400, { ok: false, error: `El mensaje supera ${MAX_MENSAJE} caracteres.` })

        // Un turno a la vez por sesión: evita mensajes entrelazados.
        const previo = colas.get(sessionId) ?? Promise.resolve()
        const turno = previo.then(() => chat(cfg, llm, sessionId, message))
        colas.set(sessionId, turno.catch(() => undefined))
        const r = await turno
        return json(res, 200, { ok: true, ...r })
      }

      json(res, 404, { ok: false, error: "Ruta no encontrada." })
    } catch {
      json(res, 500, { ok: false, error: "Error interno del servidor." })
    }
  })
}

// Arranque directo: `bun run src/server.ts`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const directory = dirname(dirname(fileURLToPath(import.meta.url)))
  const llm = crearLlm()
  const puerto = Number(process.env["PORT"] ?? 3000)
  const variableClave =
    llm.provider === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"

  crearServidor(directory, llm).listen(puerto, "0.0.0.0", () => {
    console.log(
      `Agente de OC en http://localhost:${puerto} ` +
        `(proveedor: ${llm.provider}, modelo: ${llm.model}` +
        `${llm.configurado ? "" : ` — SIN CLAVE: configure ${variableClave}`})`,
    )
  })
}
