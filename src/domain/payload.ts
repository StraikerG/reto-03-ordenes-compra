import { createHash } from "node:crypto"
import { ErrorNegocio } from "../lib/result"
import {
  OrdenCompraSchema,
  type OrdenCompra,
  type Paquete,
  type Trazabilidad,
  type Validacion,
} from "../types"

// ---------- Evidencia de aprobación ----------

export interface Evidencia {
  texto: string
  sha256: string
}

/**
 * Contenido canónico de la evidencia: encabezados + cuerpo. El sha256 se calcula
 * sobre este bloque; el archivo agrega al final una línea con el hash.
 */
export function construirEvidencia(p: Paquete): Evidencia {
  const a = p.aprobacion
  if (!a) throw new ErrorNegocio("No hay correo de aprobación para generar la evidencia.")
  const bloque = [
    `De: ${a.de}`,
    `Para: ${a.para}`,
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.cuerpo,
  ].join("\n")
  const sha256 = createHash("sha256").update(bloque, "utf8").digest("hex")
  return { texto: `${bloque}\n\n---\nsha256: ${sha256}\n`, sha256 }
}

// ---------- Payload ----------

/** Unidad de medida a partir del texto de la cotización (heurística explícita). */
export function inferirUnidad(texto: string): "UN" | "H" | "MES" {
  if (/\bhoras?\b/i.test(texto)) return "H"
  if (/\b(mensual|por mes)\b/i.test(texto)) return "MES"
  return "UN"
}

export interface ResultadoPayload {
  orden: OrdenCompra
  trazabilidad: Trazabilidad[]
}

/**
 * Construye la OC solo a partir de valores con fuente. Exige una validación
 * apta; los derivados salen de la validación, nunca del modelo.
 */
export function construirOrden(p: Paquete, v: Validacion, confirmadoPor: string | null): ResultadoPayload {
  if (!v.apta) throw new ErrorNegocio("La solicitud no es apta: resuelva los bloqueos antes de construir la OC.")
  const { proveedor, indicador_iva, condiciones_pago } = v.derivados
  if (!proveedor || !indicador_iva || !condiciones_pago || !p.aprobacion) {
    throw new ErrorNegocio("Faltan datos derivados (proveedor, IVA, condiciones de pago o aprobación) para construir la OC.")
  }
  const s = p.solicitud
  const evidencia = construirEvidencia(p)
  const textoUnidad = p.cotizacion?.item ?? s.descripcion
  const unidad = inferirUnidad(textoUnidad)
  const descripcion = s.descripcion.slice(0, 40).trimEnd()

  const orden: OrdenCompra = OrdenCompraSchema.parse({
    referencia: {
      solicitud_id: s.solicitud_id,
      correo_id: p.correo.id,
      cotizacion_ref: p.cotizacion?.referencia ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor,
    moneda: s.moneda,
    condiciones_pago: condiciones_pago.valor,
    aprobador: {
      email: p.aprobacion.de,
      fecha_aprobacion: p.aprobacion.fecha,
      evidencia_sha256: evidencia.sha256,
    },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: s.cantidad,
        unidad,
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: indicador_iva.valor,
      },
    ],
    excepciones: v.confirmaciones.map((c) => ({
      codigo: c.codigo,
      detalle: c.detalle,
      confirmado_por: confirmadoPor,
    })),
  })

  const f = (campo: string, valor: string | number | null, fuente: string): Trazabilidad => ({ campo, valor, fuente })
  const trazabilidad: Trazabilidad[] = [
    f("referencia.solicitud_id", s.solicitud_id, "solicitud"),
    f("referencia.correo_id", p.correo.id, "solicitud"),
    f("referencia.cotizacion_ref", p.cotizacion?.referencia ?? null, "cotizacion"),
    f("sociedad", "1000", "derivado"),
    f("organizacion_compras", "1000", "derivado"),
    f("proveedor.codigo_sap", proveedor.codigo_sap, "maestro.proveedores"),
    f("proveedor.nit", proveedor.nit, "maestro.proveedores"),
    f("proveedor.nombre", proveedor.nombre, "maestro.proveedores"),
    f("moneda", s.moneda, "solicitud"),
    f("condiciones_pago", condiciones_pago.valor, condiciones_pago.origen === "solicitud" ? "solicitud" : "derivado"),
    f("aprobador.email", p.aprobacion.de, "aprobacion"),
    f("aprobador.fecha_aprobacion", p.aprobacion.fecha, "aprobacion"),
    f("aprobador.evidencia_sha256", evidencia.sha256, "derivado"),
    f("posiciones[10].descripcion", descripcion, s.descripcion.length > 40 ? "derivado" : "solicitud"),
    f("posiciones[10].cantidad", s.cantidad, "solicitud"),
    f("posiciones[10].unidad", unidad, "derivado"),
    f("posiciones[10].precio_unitario", s.valor_unitario, "solicitud"),
    f("posiciones[10].centro_costo", s.centro_costo, "solicitud"),
    f("posiciones[10].subarea", s.subarea, "solicitud"),
    f("posiciones[10].indicador_iva", indicador_iva.valor, indicador_iva.origen === "solicitud" ? "solicitud" : "derivado"),
    ...v.confirmaciones.map((c, i) => f(`excepciones[${i}]`, c.codigo, "derivado")),
  ]
  return { orden, trazabilidad }
}
