import { join } from "node:path"
import { existe, leerJson, leerTexto, rutaCaso } from "../lib/files"
import { ErrorNegocio } from "../lib/result"
import {
  SolicitudSchema,
  type Aprobacion,
  type Cotizacion,
  type Factura,
  type Paquete,
} from "../types"

// ---------- utilidades de parseo ----------

/** "900.555.111-2" → "900555111" (sin puntos ni dígito de verificación). */
export function normalizarNit(nit: string): string {
  const base = nit.trim().split("-")[0] ?? ""
  return base.replace(/\D/g, "")
}

/** "11.400.000" → 11400000. Devuelve null si no es un monto válido. */
export function parsearMonto(s: string): number | null {
  const t = s.trim()
  let n: number
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) n = Number(t.replace(/\./g, "").replace(",", "."))
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) n = Number(t.replace(/,/g, ""))
  else n = Number(t.replace(",", "."))
  return Number.isFinite(n) ? n : null
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

export function parsearCotizacion(texto: string): Cotizacion {
  const proveedor = /^Proveedor:\s*(.+)$/m.exec(texto)?.[1]?.trim() ?? ""
  const nitRaw = /\bNIT:\s*([\d.\-]+)/.exec(texto)?.[1]
  const totalM = /^TOTAL[^:\n]*:\s*(?:([A-Z]{3})\s*)?([\d.,]+)/im.exec(texto)
  const total = totalM?.[2] ? parsearMonto(totalM[2]) : null
  if (total === null) throw new ErrorNegocio("La cotización no tiene un TOTAL numérico legible.")
  const fecha = /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m.exec(texto)?.[1] ?? null
  const dias = /Validez de la oferta:\s*(\d+)\s*d[ií]as/i.exec(texto)?.[1]
  return {
    proveedor,
    nit: nitRaw ? normalizarNit(nitRaw) : null,
    total,
    moneda: totalM?.[1] ?? "COP",
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    texto,
    referencia: /^COTIZACI[ÓO]N\s+(\S+)/im.exec(texto)?.[1] ?? null,
    fecha,
    item: /^\s*1\.\s*(.+?)\s*\|/m.exec(texto)?.[1] ?? null,
  }
}

export function parsearFactura(texto: string): Factura {
  const numero = /No\.\s*(\S+)/.exec(texto)?.[1]
  const fecha = /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i.exec(texto)?.[1]
  const totalRaw = /^TOTAL[^:\n]*:\s*(?:[A-Z]{3}\s*)?([\d.,]+)/im.exec(texto)?.[1]
  const total = totalRaw ? parsearMonto(totalRaw) : null
  if (!numero || !fecha || total === null) {
    throw new ErrorNegocio("La factura no tiene número, fecha de emisión o total legibles.")
  }
  return { numero, fecha, total }
}

/** "Aprobado" sin negación cercana. */
export function esAprobacion(cuerpo: string): boolean {
  const afirma = /\baprobad[oa]\b/i.test(cuerpo)
  const niega = /\b(no|sin|rechaz\w*)\b[^.\n]{0,15}\baprobad/i.test(cuerpo)
  return afirma && !niega
}

// ---------- carga del paquete ----------

interface AprobacionJson {
  de: string
  para: string
  fecha: string
  asunto: string
  cuerpo: string
}

function esAprobacionJson(x: unknown): x is AprobacionJson {
  if (typeof x !== "object" || x === null) return false
  const o = x as Record<string, unknown>
  return ["de", "para", "fecha", "asunto", "cuerpo"].every((k) => typeof o[k] === "string")
}

interface CorreoJson {
  id: string
  de: string
  asunto: string
  fecha: string
}

function esCorreoJson(x: unknown): x is CorreoJson {
  if (typeof x !== "object" || x === null) return false
  const o = x as Record<string, unknown>
  return ["id", "de", "asunto", "fecha"].every((k) => typeof o[k] === "string")
}

/** Lee y normaliza el paquete de un caso. Lanza ErrorNegocio si no se puede continuar. */
export async function cargarPaquete(dir: string, caso: string): Promise<Paquete> {
  const base = rutaCaso(dir, caso)
  if (!(await existe(base))) {
    throw new ErrorNegocio(`El caso "${caso}" no existe en fixtures/reto-03/solicitudes/.`)
  }
  const faltantes: string[] = []

  const solRuta = join(base, "solicitud.json")
  if (!(await existe(solRuta))) {
    throw new ErrorNegocio("Paquete incompleto: falta solicitud.json. Pida al solicitante reenviar el Excel de solicitud.")
  }
  const solParse = SolicitudSchema.safeParse(await leerJson(solRuta, "solicitud.json"))
  if (!solParse.success) {
    const motivos = solParse.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`)
    throw new ErrorNegocio(`La solicitud tiene datos inválidos (${motivos.join("; ")}).`)
  }

  const correoRuta = join(base, "correo.json")
  let correo = { id: `${caso}-correo`, de: "", asunto: "", fecha: "" }
  if (await existe(correoRuta)) {
    const c = await leerJson(correoRuta, "correo.json")
    if (esCorreoJson(c)) correo = { id: c.id, de: c.de, asunto: c.asunto, fecha: c.fecha }
  } else faltantes.push("correo.json")

  let cotizacion: Paquete["cotizacion"] = null
  const cotRuta = join(base, "cotizacion.txt")
  if (await existe(cotRuta)) cotizacion = parsearCotizacion(await leerTexto(cotRuta))
  else faltantes.push("cotizacion.txt")

  let aprobacion: Paquete["aprobacion"] = null
  const aprRuta = join(base, "aprobacion.json")
  if (await existe(aprRuta)) {
    const a = await leerJson(aprRuta, "aprobacion.json")
    if (!esAprobacionJson(a)) throw new ErrorNegocio("aprobacion.json no tiene los campos de, para, fecha, asunto y cuerpo.")
    const base2: Aprobacion = { de: a.de, fecha: a.fecha, aprobado: esAprobacion(a.cuerpo), texto: a.cuerpo }
    aprobacion = { ...base2, para: a.para, asunto: a.asunto, cuerpo: a.cuerpo }
  } else faltantes.push("aprobacion.json")

  // La factura solo existe en el caso retroactivo: su ausencia NO es un faltante.
  let factura: Paquete["factura"] = null
  const facRuta = join(base, "factura.txt")
  if (await existe(facRuta)) factura = parsearFactura(await leerTexto(facRuta))

  return { caso, correo, solicitud: solParse.data, cotizacion, aprobacion, factura, faltantes }
}
