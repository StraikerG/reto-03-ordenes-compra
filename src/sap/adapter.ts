import type { OrdenCompra } from "../types"

/**
 * Frontera con SAP. Hoy la implementa `mock.ts` sobre archivos en `out/sap/`.
 * La implementación real (OData / BAPI / Integration Suite) se describe en SOLUCION.md §6.
 */
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  /** `fecha` es opcional para no obligar a los adaptadores reales a devolverla. */
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string; fecha?: string } | null>
}
