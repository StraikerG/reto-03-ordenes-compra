import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ErrorNegocio } from "./result"

export const CASO_RE = /^[A-Za-z0-9_-]+$/

export function rutaFixture(dir: string, ...partes: string[]): string {
  return join(dir, "fixtures", "reto-03", ...partes)
}

export function rutaOut(dir: string, ...partes: string[]): string {
  return join(dir, "out", ...partes)
}

export function rutaCaso(dir: string, caso: string): string {
  if (!CASO_RE.test(caso)) throw new ErrorNegocio(`Nombre de caso inválido: "${caso}".`)
  return rutaFixture(dir, "solicitudes", caso)
}

export async function existe(ruta: string): Promise<boolean> {
  try {
    await stat(ruta)
    return true
  } catch {
    return false
  }
}

export async function leerTexto(ruta: string): Promise<string> {
  return readFile(ruta, "utf8")
}

export async function leerJson(ruta: string, nombre: string): Promise<unknown> {
  const txt = await leerTexto(ruta)
  try {
    return JSON.parse(txt)
  } catch {
    throw new ErrorNegocio(`${nombre} está malformado (JSON inválido).`)
  }
}

export async function escribir(ruta: string, contenido: string): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await writeFile(ruta, contenido, "utf8")
}

export async function anexar(ruta: string, linea: string): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await appendFile(ruta, linea, "utf8")
}

/** Ruta relativa a la raíz del proyecto, para mostrar al usuario. */
export function relativa(dir: string, ruta: string): string {
  return ruta.startsWith(dir) ? ruta.slice(dir.length + 1) : ruta
}
