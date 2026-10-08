/** Contrato de salida de toda herramienta: string JSON, nunca lanza. */

export function ok(data: unknown): string {
  return JSON.stringify({ ok: true, data })
}

export function fail(error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, error, ...extra })
}

/** Convierte cualquier excepción en un `{ ok:false, error }` legible, sin traza. */
export async function seguro(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ErrorNegocio) return fail(e.message)
    const msg = e instanceof Error ? e.message : String(e)
    return fail(`Error inesperado: ${msg}`)
  }
}

/** Error de negocio con mensaje apto para mostrar al usuario. */
export class ErrorNegocio extends Error {}
