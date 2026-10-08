import { z } from "zod/v4"
import { construirEvidencia, construirOrden } from "../domain/payload"
import { cargarMaestros } from "../domain/maestros"
import { cargarPaquete } from "../domain/paquete"
import { validarPaquete } from "../domain/reglas"
import { registrarControl } from "../lib/control"
import { CASO_RE, escribir, relativa, rutaOut } from "../lib/files"
import { fail, ok, seguro } from "../lib/result"
import { SapMock } from "../sap/mock"
import type { Ctx } from "../types"

/**
 * Herramientas del agente. Cada export `x` se expone al modelo como `oc_x`.
 * Son la ÚNICA fuente de valores que el agente puede afirmar (CA2): por eso
 * releen el paquete desde la fuente y ignoran cualquier objeto que el modelo
 * intente pasarles (`paquete`, `payload`).
 */

const caso = z
  .string()
  .regex(CASO_RE, "El nombre del caso solo admite letras, números, guion y guion bajo (ej. sol-001).")
  .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo sol-001")

const ignorado = (que: string) =>
  z.unknown().optional().describe(`Opcional y se ignora: el servidor relee ${que} desde la fuente. No lo envíes.`)

async function evaluar(ctx: Ctx, nombreCaso: string) {
  const sap = new SapMock(ctx.directory)
  const [paquete, maestros] = await Promise.all([cargarPaquete(ctx.directory, nombreCaso), cargarMaestros(ctx.directory)])
  const validacion = await validarPaquete(paquete, maestros, sap)
  return { sap, paquete, validacion }
}

export const leer_paquete = {
  description:
    "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si existe) de un caso y los devuelve normalizados.",
  args: { caso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return seguro(async () => {
      const { cotizacion, aprobacion, ...resto } = await cargarPaquete(ctx.directory, args.caso)
      // Se omite el texto crudo de la cotización y la copia duplicada del cuerpo para ahorrar tokens.
      const cotizacionResumen = cotizacion ? (({ texto: _texto, ...r }) => r)(cotizacion) : null
      const aprobacionResumen = aprobacion
        ? { de: aprobacion.de, para: aprobacion.para, fecha: aprobacion.fecha, asunto: aprobacion.asunto, aprobado: aprobacion.aprobado, cuerpo: aprobacion.cuerpo }
        : null
      return ok({ ...resto, cotizacion: cotizacionResumen, aprobacion: aprobacionResumen })
    })
  },
}

export const validar = {
  description:
    "Aplica los controles RC1–RC10 al caso: devuelve si es apta, los bloqueos, las confirmaciones requeridas, los valores derivados de maestros y si es retroactiva.",
  args: { caso, paquete: ignorado("el paquete") },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return seguro(async () => {
      const { validacion } = await evaluar(ctx, args.caso)
      return ok(validacion)
    })
  },
}

export const construir_payload = {
  description:
    "Construye la orden de compra tal como quedaría en SAP (solo si el caso es apta) y guarda la trazabilidad de cada valor en out/<caso>/trazabilidad.json.",
  args: { caso, paquete: ignorado("el paquete"), derivados: ignorado("los derivados") },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return seguro(async () => {
      const { paquete, validacion } = await evaluar(ctx, args.caso)
      if (!validacion.apta) {
        return fail("No se puede construir la OC: el caso tiene bloqueos.", { bloqueos: validacion.bloqueos })
      }
      const { orden, trazabilidad } = construirOrden(paquete, validacion, null)
      const ruta = rutaOut(ctx.directory, args.caso, "trazabilidad.json")
      await escribir(ruta, JSON.stringify(trazabilidad, null, 2))
      return ok({
        payload: orden,
        trazabilidad_ruta: relativa(ctx.directory, ruta),
        confirmaciones_pendientes: validacion.confirmaciones.map((c) => c.codigo),
      })
    })
  },
}

export const generar_evidencia = {
  description:
    "Genera out/<caso>/aprobacion.txt con el correo de aprobación (de, para, fecha, asunto, cuerpo) y su sha256.",
  args: { caso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return seguro(async () => {
      const paquete = await cargarPaquete(ctx.directory, args.caso)
      const ev = construirEvidencia(paquete)
      const ruta = rutaOut(ctx.directory, args.caso, "aprobacion.txt")
      await escribir(ruta, ev.texto)
      return ok({ ruta: relativa(ctx.directory, ruta), sha256: ev.sha256 })
    })
  },
}

export const crear = {
  description:
    "Crea la OC en el SAP simulado si el caso es apta. Con confirmaciones pendientes exige confirmado=true, que solo vale si el usuario acaba de confirmar. Es idempotente por solicitud y deja un registro en out/control.csv; llámala también en casos bloqueados para dejar la traza.",
  args: {
    caso,
    payload: ignorado("el payload"),
    confirmado: z
      .boolean()
      .optional()
      .describe("true SOLO si el usuario confirmó explícitamente las excepciones en su último mensaje."),
  },
  async execute(args: { caso: string; confirmado?: boolean }, ctx: Ctx): Promise<string> {
    return seguro(async () => {
      const { sap, paquete, validacion } = await evaluar(ctx, args.caso)
      const sid = paquete.solicitud.solicitud_id
      const base = {
        solicitud_id: sid,
        retroactiva: validacion.retroactiva,
        bloqueos: validacion.bloqueos.map((b) => b.codigo),
        confirmaciones: validacion.confirmaciones.map((c) => c.codigo),
      }

      // Idempotencia: la misma solicitud devuelve la OC existente, sin crear otra.
      const existente = await sap.buscarOrdenPorReferencia(sid)
      if (existente) {
        await registrarControl(ctx.directory, { ...base, resultado: "idempotente", numero_oc: existente.numero_oc })
        return ok({ numero_oc: existente.numero_oc, fecha: existente.fecha ?? null, idempotente: true })
      }

      if (!validacion.apta) {
        await registrarControl(ctx.directory, { ...base, resultado: "bloqueada", numero_oc: null })
        return fail("OC no creada: el caso tiene bloqueos.", { codigo: "BLOQUEADA", bloqueos: validacion.bloqueos })
      }

      const requiere = validacion.confirmaciones.length > 0
      if (requiere && !args.confirmado) {
        await registrarControl(ctx.directory, { ...base, resultado: "pendiente_confirmacion", numero_oc: null })
        return fail("requiere confirmación explícita del usuario antes de crear la OC.", {
          codigo: "REQUIERE_CONFIRMACION",
          confirmaciones: validacion.confirmaciones,
        })
      }
      if (requiere && ctx.puedeConfirmar && !ctx.puedeConfirmar(args.caso)) {
        await registrarControl(ctx.directory, { ...base, resultado: "pendiente_confirmacion", numero_oc: null })
        return fail(
          "La confirmación no es válida: primero hay que mostrarle las excepciones al usuario y esperar su respuesta en el siguiente mensaje.",
          { codigo: "REQUIERE_CONFIRMACION", confirmaciones: validacion.confirmaciones },
        )
      }

      // Evidencia + payload definitivo (con quién confirmó cada excepción).
      const ev = construirEvidencia(paquete)
      await escribir(rutaOut(ctx.directory, args.caso, "aprobacion.txt"), ev.texto)
      const { orden, trazabilidad } = construirOrden(paquete, validacion, requiere ? (ctx.usuario ?? "analista") : null)
      await escribir(rutaOut(ctx.directory, args.caso, "trazabilidad.json"), JSON.stringify(trazabilidad, null, 2))

      const { numero_oc, fecha } = await sap.crearOrden(orden)
      await registrarControl(ctx.directory, { ...base, resultado: "creada", numero_oc })
      return ok({ numero_oc, fecha, idempotente: false, retroactiva: validacion.retroactiva })
    })
  },
}
