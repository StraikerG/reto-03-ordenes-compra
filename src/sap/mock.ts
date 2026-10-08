import { existe, leerJson, leerTexto, anexar, rutaFixture, rutaOut } from "../lib/files"
import type { OrdenCompra, Proveedor } from "../types"
import type { SapAdapter } from "./adapter"

const PRIMER_NUMERO = 4500000001

interface Registro {
  numero_oc: string
  fecha: string
  orden: OrdenCompra
}

/** Serializa las escrituras para que dos OC simultáneas no reciban el mismo número. */
let cola: Promise<void> = Promise.resolve()
function exclusivo<T>(fn: () => Promise<T>): Promise<T> {
  const r = cola.then(fn)
  cola = r.then(
    () => undefined,
    () => undefined,
  )
  return r
}

export class SapMock implements SapAdapter {
  private readonly archivo: string

  constructor(private readonly directory: string) {
    this.archivo = rutaOut(directory, "sap", "ordenes.jsonl")
  }

  private async leerRegistros(): Promise<Registro[]> {
    if (!(await existe(this.archivo))) return []
    const txt = await leerTexto(this.archivo)
    return txt
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Registro)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const lista = (await leerJson(rutaFixture(this.directory, "maestros", "proveedores.json"), "proveedores.json")) as Proveedor[]
    const p = lista.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string; fecha: string } | null> {
    const r = (await this.leerRegistros()).find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc, fecha: r.fecha } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    return exclusivo(async () => {
      const registros = await this.leerRegistros()
      const previa = registros.find((x) => x.orden.referencia.solicitud_id === orden.referencia.solicitud_id)
      if (previa) return { numero_oc: previa.numero_oc, fecha: previa.fecha }
      const numero_oc = String(PRIMER_NUMERO + registros.length)
      const fecha = new Date().toISOString().slice(0, 10)
      const reg: Registro = { numero_oc, fecha, orden }
      await anexar(this.archivo, JSON.stringify(reg) + "\n")
      return { numero_oc, fecha }
    })
  }
}
