/**
 * Verificación sin modelo: ejecuta las herramientas directamente sobre los 6
 * casos y comprueba el resultado esperado de cada uno.
 *
 *   bun install && bun run demo.ts
 *
 * No necesita clave de ningún proveedor. Limpia out/ al inicio.
 */
import { rm } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ejecutarHerramienta } from "./src/tools"
import type { Ctx } from "./src/types"

const directory = dirname(fileURLToPath(import.meta.url))
const ctx: Ctx = { directory, sessionId: "demo", usuario: "analista-demo" }

interface Respuesta {
  ok: boolean
  error?: string
  codigo?: string
  data?: Record<string, unknown>
  bloqueos?: Array<{ codigo: string }>
  confirmaciones?: Array<{ codigo: string }>
}

async function llamar(nombre: string, args: Record<string, unknown>): Promise<Respuesta> {
  const e = await ejecutarHerramienta(nombre, args, ctx)
  return JSON.parse(e.resultado) as Respuesta
}

let fallos = 0
function verificar(condicion: boolean, mensaje: string): void {
  if (!condicion) {
    fallos++
    console.log(`   ✗ ${mensaje}`)
  }
}

interface Validacion {
  apta: boolean
  bloqueos: Array<{ codigo: string }>
  confirmaciones: Array<{ codigo: string }>
  derivados: Record<string, { valor: string; origen: string } | undefined>
  retroactiva: boolean
}

async function caso(nombre: string, esperado: string, fn: () => Promise<string>): Promise<void> {
  console.log(`\n▶ ${nombre} — esperado: ${esperado}`)
  try {
    console.log(`   → ${await fn()}`)
  } catch (e) {
    fallos++
    console.log(`   ✗ excepción no controlada: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function validar(c: string): Promise<Validacion> {
  const r = await llamar("oc_validar", { caso: c })
  return r.data as unknown as Validacion
}

await rm(`${directory}/out`, { recursive: true, force: true })
console.log("Demo del agente de órdenes de compra (sin modelo de lenguaje)")

await caso("sol-001", "OC creada sin intervención humana", async () => {
  const v = await validar("sol-001")
  verificar(v.apta && v.confirmaciones.length === 0, "debía ser apta y sin confirmaciones")
  const ev = await llamar("oc_generar_evidencia", { caso: "sol-001" })
  verificar(ev.ok, "la evidencia debía generarse")
  const p = await llamar("oc_construir_payload", { caso: "sol-001" })
  verificar(p.ok, "el payload debía construirse")
  const r = await llamar("oc_crear", { caso: "sol-001" })
  verificar(r.ok && r.data?.["numero_oc"] === "4500000001", "debía crear la OC 4500000001")
  const r2 = await llamar("oc_crear", { caso: "sol-001" })
  verificar(r2.ok && r2.data?.["idempotente"] === true && r2.data["numero_oc"] === "4500000001", "el segundo intento debía ser idempotente")
  return `OC ${String(r.data?.["numero_oc"])}; reintento idempotente=${String(r2.data?.["idempotente"])}`
})

await caso("sol-002", "bloqueada: proveedor inexistente (RC1)", async () => {
  const v = await validar("sol-002")
  verificar(!v.apta && v.bloqueos.some((b) => b.codigo === "RC1"), "debía bloquear por RC1")
  const r = await llamar("oc_crear", { caso: "sol-002" })
  verificar(!r.ok && r.codigo === "BLOQUEADA", "no debía crear la OC")
  return `${r.error} [${v.bloqueos.map((b) => b.codigo).join(", ")}]`
})

await caso("sol-003", "bloqueada: aprobador sin autoridad (RC2)", async () => {
  const v = await validar("sol-003")
  verificar(!v.apta && v.bloqueos.some((b) => b.codigo === "RC2"), "debía bloquear por RC2")
  const r = await llamar("oc_crear", { caso: "sol-003", confirmado: true })
  verificar(!r.ok, "ni con confirmación se puede crear un caso bloqueado")
  return `${r.error} [${v.bloqueos.map((b) => b.codigo).join(", ")}]`
})

await caso("sol-004", "pide confirmación: cotización ≠ solicitud (RC5), luego crea", async () => {
  const v = await validar("sol-004")
  verificar(v.apta && v.confirmaciones.some((c) => c.codigo === "RC5"), "debía requerir confirmación RC5")
  const sin = await llamar("oc_crear", { caso: "sol-004" })
  verificar(!sin.ok && sin.codigo === "REQUIERE_CONFIRMACION", "sin confirmar no debía crear")
  const con = await llamar("oc_crear", { caso: "sol-004", confirmado: true })
  verificar(con.ok && con.data?.["numero_oc"] === "4500000002", "confirmada debía crear 4500000002")
  return `sin confirmar → ${sin.codigo}; confirmada → OC ${String(con.data?.["numero_oc"])}`
})

await caso("sol-005", "retroactiva: factura anterior a la solicitud (RC8), crea con confirmación", async () => {
  const v = await validar("sol-005")
  verificar(v.apta && v.retroactiva && v.confirmaciones.some((c) => c.codigo === "RC8"), "debía ser retroactiva con RC8")
  const sin = await llamar("oc_crear", { caso: "sol-005" })
  verificar(!sin.ok && sin.codigo === "REQUIERE_CONFIRMACION", "sin confirmar no debía crear")
  const con = await llamar("oc_crear", { caso: "sol-005", confirmado: true })
  verificar(con.ok && con.data?.["retroactiva"] === true, "debía crear marcada retroactiva")
  return `OC ${String(con.data?.["numero_oc"])} retroactiva=${String(con.data?.["retroactiva"])}`
})

await caso("sol-006", "IVA no informado (RC6): deriva C1 y pide confirmación; condiciones derivadas (RC7)", async () => {
  const v = await validar("sol-006")
  verificar(v.apta && v.confirmaciones.some((c) => c.codigo === "RC6"), "debía requerir confirmación RC6")
  verificar(v.derivados["indicador_iva"]?.valor === "C1" && v.derivados["indicador_iva"].origen === "derivado", "IVA derivado C1")
  verificar(v.derivados["condiciones_pago"]?.valor === "Z030" && v.derivados["condiciones_pago"].origen === "derivado", "pago derivado Z030")
  const sin = await llamar("oc_crear", { caso: "sol-006" })
  verificar(!sin.ok && sin.codigo === "REQUIERE_CONFIRMACION", "sin confirmar no debía crear")
  const con = await llamar("oc_crear", { caso: "sol-006", confirmado: true })
  verificar(con.ok, "confirmada debía crear")
  return `derivados IVA=${v.derivados["indicador_iva"]?.valor}, pago=${v.derivados["condiciones_pago"]?.valor}; OC ${String(con.data?.["numero_oc"])}`
})

await caso("errores", "caso inexistente y nombre inválido devuelven { ok:false } legible", async () => {
  const a = await llamar("oc_leer_paquete", { caso: "sol-999" })
  const b = await llamar("oc_leer_paquete", { caso: "../../etc" })
  verificar(!a.ok && typeof a.error === "string", "caso inexistente debía fallar con mensaje")
  verificar(!b.ok, "un caso con '../' debía rechazarse")
  return `${a.error} | ${b.error}`
})

console.log(`\nSalidas en out/: control.csv, sap/ordenes.jsonl, log.jsonl y out/<caso>/{aprobacion.txt,trazabilidad.json}`)
if (fallos > 0) {
  console.log(`\n✗ ${fallos} verificación(es) fallaron`)
  process.exit(1)
}
console.log("\n✓ Todas las verificaciones pasaron")
