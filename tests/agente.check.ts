/**
 * Pruebas del ciclo del agente y del servidor con un LLM falso (sin red, sin clave).
 *   bun run tests/agente.check.ts
 */
import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chat, type ConfigAgente } from "../src/agent"
import { ErrorLlm, type LlmAdapter, type Mensaje, type RespuestaLlm } from "../src/llm/adapter"
import { crearServidor } from "../src/server"

const directory = dirname(dirname(fileURLToPath(import.meta.url)))
await rm(join(directory, "out"), { recursive: true, force: true })

const uso = { input: 10, output: 5 }
const llamar = (id: string, name: string, args: Record<string, unknown>): RespuestaLlm => ({
  content: "",
  toolCalls: [{ id, name, args }],
  usage: uso,
})
const texto = (content: string): RespuestaLlm => ({ content, toolCalls: [], usage: uso })

class Falso implements LlmAdapter {
  readonly provider = "falso"
  readonly model = "falso-1"
  readonly configurado = true
  llamadas = 0
  constructor(private readonly guion: (m: Mensaje[], herramientas: number) => RespuestaLlm) {}
  async enviar(m: Mensaje[], h: Array<unknown>): Promise<RespuestaLlm> {
    this.llamadas++
    return this.guion(m, h.length)
  }
}

const cfg: ConfigAgente = { directory, maxIter: 6, maxTokensSesion: 10_000, maxTokensGlobal: 1_000_000 }
const ultimo = (m: Mensaje[]) => m[m.length - 1]
const resultadoTool = (m: Mensaje[]) => {
  const u = ultimo(m)
  return u?.role === "tool" ? (JSON.parse(u.content) as { ok: boolean; codigo?: string }) : null
}

// 1) Flujo con confirmación: turno 1 pide confirmar, turno 2 crea.
{
  const llm = new Falso((m) => {
    const u = ultimo(m)
    if (u?.role === "user" && u.content.startsWith("procesa")) return llamar("a1", "oc_crear", { caso: "sol-004" })
    if (u?.role === "user" && u.content === "sí") return llamar("a2", "oc_crear", { caso: "sol-004", confirmado: true })
    const r = resultadoTool(m)
    if (r?.codigo === "REQUIERE_CONFIRMACION") return texto("¿Confirmas crear la OC con la excepción RC5?")
    if (r?.ok) return texto("OC creada.")
    return texto("?")
  })
  const t1 = await chat(cfg, llm, "sesion-flujo-1", "procesa sol-004")
  assert.equal(t1.needsConfirmation, true, "turno 1 debe quedar esperando confirmación")
  assert.deepEqual(t1.casosPendientes, ["sol-004"])
  assert.equal(t1.toolCalls.length, 1)
  const t2 = await chat(cfg, llm, "sesion-flujo-1", "sí")
  assert.match(t2.reply, /OC creada exitosamente/)
  assert.equal(t2.needsConfirmation, false, "la confirmación debe consumirse")
  assert.doesNotMatch(
    t2.reply,
    /Falta tu confirmación|¿Confirmas crear/i,
    "no debe pedir confirmación nuevamente después de crear la OC",
  )
  assert.ok(t2.toolCalls[0]?.ok, "crear confirmada debe ser ok")
  console.log("✓ confirmación humana: pide en el turno 1 y crea en el turno 2")
}

// 2) El modelo intenta confirmar por su cuenta (sin que el turno anterior lo pidiera): se rechaza.
{
  const llm = new Falso((m) => {
    if (ultimo(m)?.role === "user") return llamar("b1", "oc_crear", { caso: "sol-005", confirmado: true })
    return texto(resultadoTool(m)?.ok ? "creada" : "no se pudo")
  })
  const t = await chat(cfg, llm, "sesion-trampa-1", "procesa sol-005")
  assert.equal(t.toolCalls[0]?.ok, false, "confirmado=true sin pregunta previa debe fallar")
  assert.equal(t.reply, "no se pudo")
  assert.equal(t.needsConfirmation, true, "queda en espera de confirmación real")
  console.log("✓ el modelo no puede saltarse la confirmación con confirmado=true")
}

// 3) Tope de iteraciones: el modelo entra en bucle; al llegar al tope hay un cierre sin herramientas.
{
  const llm = new Falso((m, nHerr) => (nHerr === 0 ? texto("Resumen: no terminé.") : llamar(`c${m.length}`, "oc_leer_paquete", { caso: "sol-001" })))
  const t = await chat(cfg, llm, "sesion-bucle-1", "procesa sol-001")
  assert.equal(t.toolCalls.length, cfg.maxIter)
  assert.equal(t.reply, "Resumen: no terminé.")
  assert.equal(llm.llamadas, cfg.maxIter + 1)
  console.log(`✓ tope de iteraciones (${cfg.maxIter}) y cierre sin herramientas`)
}

// 4) Error del proveedor: mensaje claro, la sesión sigue viva y conserva la posibilidad de confirmar.
{
  let falla = false
  const llm = new Falso((m) => {
    if (falla) throw new ErrorLlm("El modelo no respondió a tiempo. Intente de nuevo.")
    const u = ultimo(m)
    if (u?.role === "user") return llamar("d1", "oc_crear", { caso: "sol-006" })
    return texto(resultadoTool(m)?.codigo === "REQUIERE_CONFIRMACION" ? "¿Confirmas?" : "ok")
  })
  const t1 = await chat(cfg, llm, "sesion-error-1", "procesa sol-006")
  assert.equal(t1.needsConfirmation, true)
  falla = true
  const t2 = await chat(cfg, llm, "sesion-error-1", "sí")
  assert.match(t2.reply, /^⚠️ El modelo no respondió/)
  assert.equal(t2.needsConfirmation, true, "tras el fallo sigue pudiendo confirmar")
  falla = false
  console.log("✓ error del proveedor: mensaje claro y sesión viva")
}

// 5) Tope de tokens por sesión.
{
  const llm = new Falso(() => texto("hola"))
  const chico: ConfigAgente = { ...cfg, maxTokensSesion: 20 }
  await chat(chico, llm, "sesion-tokens-1", "hola")
  await chat(chico, llm, "sesion-tokens-1", "hola")
  const t = await chat(chico, llm, "sesion-tokens-1", "hola")
  assert.match(t.reply, /límite de uso/)
  console.log("✓ tope de tokens por sesión")
}

// 6) Servidor HTTP real.
{
  const llm = new Falso(() => texto("hola desde el servidor"))
  const srv = crearServidor(directory, llm, { RATE_LIMIT_PER_MIN: "3" })
  await new Promise<void>((r) => srv.listen(0, r))
  const addr = srv.address()
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`
  const post = (cuerpo: unknown) =>
    fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify(cuerpo) }).then(async (r) => ({ status: r.status, j: (await r.json()) as Record<string, unknown> }))

  const health = (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>
  assert.deepEqual(health, { ok: true, provider: "falso", model: "falso-1", configured: true })
  const a = await post({ sessionId: "sesion-http-1", message: "hola" })
  assert.equal(a.status, 200)
  assert.equal(a.j["reply"], "hola desde el servidor")
  const malo = await post({ sessionId: "x", message: "hola" })
  assert.equal(malo.status, 400)
  const hist = (await (await fetch(`${base}/api/sessions/sesion-http-1`)).json()) as { historial: unknown[] }
  assert.equal(hist.historial.length, 2)
  assert.equal((await fetch(`${base}/api/sessions/no-existe-1234`)).status, 404)
  assert.equal((await (await fetch(`${base}/`)).text()).includes("Órdenes de compra"), true)
  assert.equal((await post({ sessionId: "sesion-http-1", message: "tercera" })).status, 200)
  const limite = await post({ sessionId: "sesion-http-1", message: "otra" })
  assert.equal(limite.status, 429, "la 4.ª solicitud del minuto debe limitarse")
  srv.close()
  console.log("✓ servidor: /api/health, /api/chat, validación, historial, front y límite de tasa")
}

console.log("\n✓ Todas las pruebas del agente pasaron")
