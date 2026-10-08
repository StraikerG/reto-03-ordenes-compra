import { anexar, existe, rutaOut } from "./files"

/** Registro de control para contabilidad/auditoría: `out/control.csv`. */

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"

export type ResultadoControl = "creada" | "idempotente" | "bloqueada" | "pendiente_confirmacion"

export interface FilaControl {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

function celda(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

export async function registrarControl(dir: string, fila: FilaControl): Promise<void> {
  const ruta = rutaOut(dir, "control.csv")
  if (!(await existe(ruta))) await anexar(ruta, ENCABEZADO)
  const linea = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join(";"),
    fila.confirmaciones.join(";"),
    new Date().toISOString(),
  ]
    .map(celda)
    .join(",")
  await anexar(ruta, linea + "\n")
}
