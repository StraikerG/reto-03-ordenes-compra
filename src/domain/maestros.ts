import { leerJson, rutaFixture } from "../lib/files"
import { ErrorNegocio } from "../lib/result"
import type { Maestros } from "../types"

async function cargar<T>(dir: string, archivo: string): Promise<T> {
  const datos = await leerJson(rutaFixture(dir, "maestros", archivo), archivo)
  if (!Array.isArray(datos)) throw new ErrorNegocio(`El maestro ${archivo} debe ser una lista.`)
  return datos as T
}

export async function cargarMaestros(dir: string): Promise<Maestros> {
  const [proveedores, centrosCosto, indicadoresIva, condicionesPago] = await Promise.all([
    cargar<Maestros["proveedores"]>(dir, "proveedores.json"),
    cargar<Maestros["centrosCosto"]>(dir, "centros-costo.json"),
    cargar<Maestros["indicadoresIva"]>(dir, "indicadores-iva.json"),
    cargar<Maestros["condicionesPago"]>(dir, "condiciones-pago.json"),
  ])
  return { proveedores, centrosCosto, indicadoresIva, condicionesPago }
}

/** Normaliza razón social: sin tildes, sin signos ni sufijos societarios. */
export function normalizarNombre(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(s a s|sas|s a|ltda|sa|ltd)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
