import { z } from "zod/v4"

/** Contexto que recibe cada herramienta. `directory` es la raíz del proyecto. */
export interface Ctx {
  directory: string
  sessionId: string
  /** Quién confirma las excepciones (queda en el payload). */
  usuario?: string
  /**
   * Control de confirmación humana (CA3). Si está definido, `confirmado=true`
   * solo se acepta cuando el turno anterior pidió confirmar ese caso.
   * En `demo.ts` no se define: el script hace de usuario.
   */
  puedeConfirmar?: (caso: string) => boolean
}

export interface Herramienta {
  description: string
  args: z.ZodRawShape
  execute: (args: never, ctx: Ctx) => Promise<string>
}

// ---------- Entrada: solicitud (solicitud.xlsx normalizado a JSON) ----------

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number(),
  valor_unitario: z.number(),
  valor_total: z.number(),
  moneda: z.string().min(1),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.iso.date(),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export interface Cotizacion {
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  texto: string
  referencia: string | null
  fecha: string | null
  item: string | null
}

export interface Aprobacion {
  de: string
  fecha: string
  aprobado: boolean
  texto: string
}

export interface Factura {
  numero: string
  fecha: string
  total: number
}

export interface Paquete {
  caso: string
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: (Aprobacion & { para: string; asunto: string; cuerpo: string }) | null
  factura: Factura | null
  /** Piezas del paquete que no estaban (ej. "cotizacion.txt"). */
  faltantes: string[]
}

// ---------- Maestros ----------

export interface Proveedor {
  codigo_sap: string
  nit: string
  nombre: string
  condiciones_pago_default: string
  indicador_iva_default: string
  activo: boolean
}
export interface CentroCosto {
  centro_costo: string
  nombre: string
  subareas: string[]
  aprobadores: Array<{ email: string; nombre: string; tope: number }>
}
export interface Maestros {
  proveedores: Proveedor[]
  centrosCosto: CentroCosto[]
  indicadoresIva: Array<{ codigo: string; descripcion: string; tasa: number }>
  condicionesPago: Array<{ codigo: string; descripcion: string; dias: number }>
}

// ---------- Validación ----------

export interface Hallazgo {
  codigo: string
  detalle: string
  accion_sugerida: string
}

export interface Derivados {
  proveedor?: { codigo_sap: string; nit: string; nombre: string }
  indicador_iva?: { valor: string; origen: "solicitud" | "derivado" }
  condiciones_pago?: { valor: string; origen: "solicitud" | "derivado" }
  aprobador?: { email: string; tope: number }
}

export interface Validacion {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
}

// ---------- Salida: orden de compra (7.4) ----------

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string().length(64),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int(),
        descripcion: z.string().max(40),
        cantidad: z.number(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }),
  ),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export interface Trazabilidad {
  campo: string
  valor: string | number | null
  fuente: string
}
