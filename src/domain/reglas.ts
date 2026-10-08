import type { SapAdapter } from "../sap/adapter"
import type { Derivados, Hallazgo, Maestros, Paquete, Validacion } from "../types"
import { normalizarNombre } from "./maestros"
import { normalizarNit } from "./paquete"

const TOLERANCIA_COTIZACION = 0.02 // RC5
const TOLERANCIA_TOTAL = 1 // RC10, en unidades monetarias

const COP = (n: number) => `COP ${n.toLocaleString("es-CO")}`
const dia = (iso: string) => iso.slice(0, 10)

function h(codigo: string, detalle: string, accion_sugerida: string): Hallazgo {
  return { codigo, detalle, accion_sugerida }
}

/**
 * Aplica RC1–RC10 sobre un paquete. Función pura salvo por la consulta de
 * proveedor al adaptador SAP. No lanza: todo hallazgo se devuelve como dato.
 */
export async function validarPaquete(p: Paquete, m: Maestros, sap: SapAdapter): Promise<Validacion> {
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const derivados: Derivados = {}
  const s = p.solicitud

  // Moneda soportada por el payload (7.4)
  if (s.moneda !== "COP" && s.moneda !== "USD") {
    bloqueos.push(h("MONEDA", `Moneda "${s.moneda}" no soportada (solo COP o USD).`, "Pedir al solicitante corregir la moneda en la solicitud."))
  }

  // RC10 — cantidad × valor_unitario = valor_total (± 1)
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > TOLERANCIA_TOTAL) {
    bloqueos.push(
      h(
        "RC10",
        `cantidad × valor unitario = ${COP(calculado)}, pero el valor total de la solicitud es ${COP(s.valor_total)}.`,
        "Pedir al solicitante corregir cantidad, valor unitario o valor total.",
      ),
    )
  }

  // RC1 — proveedor existe (por NIT; sin NIT, por nombre normalizado) y está activo
  const nitSol = s.proveedor_nit ? normalizarNit(s.proveedor_nit) : null
  const prov = nitSol
    ? m.proveedores.find((x) => x.nit === nitSol)
    : m.proveedores.find((x) => normalizarNombre(x.nombre) === normalizarNombre(s.proveedor_nombre))
  if (!prov) {
    bloqueos.push(
      h(
        "RC1",
        `El proveedor "${s.proveedor_nombre}"${nitSol ? ` (NIT ${nitSol})` : ""} no existe en el maestro de proveedores.`,
        "Solicitar el alta del proveedor en SAP (compras/tesorería) y reprocesar la solicitud.",
      ),
    )
  } else {
    const enSap = await sap.consultarProveedor(prov.nit)
    if (!prov.activo || !enSap || !enSap.activo) {
      bloqueos.push(h("RC1", `El proveedor "${prov.nombre}" está inactivo en el maestro.`, "Pedir la reactivación del proveedor o elegir otro."))
    } else {
      derivados.proveedor = { codigo_sap: enSap.codigo_sap, nit: prov.nit, nombre: prov.nombre }
    }
    if (p.cotizacion?.nit && p.cotizacion.nit !== prov.nit) {
      confirmaciones.push(
        h("RC1b", `El NIT de la cotización (${p.cotizacion.nit}) no coincide con el del proveedor (${prov.nit}).`, "Confirmar con el solicitante que la cotización corresponde al proveedor correcto."),
      )
    }
  }

  // RC4 — subárea pertenece al centro de costo
  const centro = m.centrosCosto.find((c) => c.centro_costo === s.centro_costo)
  if (!centro) {
    bloqueos.push(h("RC4", `El centro de costo ${s.centro_costo} no existe en el maestro.`, "Pedir al solicitante el centro de costo correcto."))
  } else if (!centro.subareas.includes(s.subarea)) {
    bloqueos.push(
      h(
        "RC4",
        `La subárea "${s.subarea}" no pertenece al centro ${s.centro_costo} (válidas: ${centro.subareas.join(", ")}).`,
        "Pedir al solicitante corregir la subárea o el centro de costo.",
      ),
    )
  }

  // RC2 — aprobación existe, dice "Aprobado" y viene de un aprobador del centro
  const apr = p.aprobacion
  if (!apr) {
    bloqueos.push(h("RC2", "No hay correo de aprobación en el paquete.", "Pedir al solicitante el correo de aprobación de su líder."))
  } else if (!apr.aprobado) {
    bloqueos.push(h("RC2", `El correo de ${apr.de} no contiene una aprobación explícita.`, "Pedir al líder responder el correo con \"Aprobado\"."))
  } else if (centro) {
    const aprobador = centro.aprobadores.find((a) => a.email.toLowerCase() === apr.de.toLowerCase())
    if (!aprobador) {
      const maxTope = Math.max(...centro.aprobadores.map((a) => a.tope))
      bloqueos.push(
        h(
          "RC2",
          `${apr.de} no es aprobador del centro ${s.centro_costo}. Aprobadores válidos: ${centro.aprobadores.map((a) => a.email).join(", ")}.` +
            (s.valor_total > maxTope ? ` Además el valor ${COP(s.valor_total)} supera el tope máximo del centro (${COP(maxTope)}).` : ""),
          "Obtener la aprobación de un aprobador autorizado del centro de costo con tope suficiente.",
        ),
      )
    } else {
      derivados.aprobador = { email: aprobador.email, tope: aprobador.tope }
      // RC3 — valor ≤ tope
      if (s.valor_total > aprobador.tope) {
        bloqueos.push(
          h(
            "RC3",
            `El valor ${COP(s.valor_total)} supera el tope de ${apr.de} (${COP(aprobador.tope)}).`,
            "Escalar la aprobación a un aprobador del centro con tope mayor.",
          ),
        )
      }
    }
  }

  // RC9 — la aprobación no puede ser anterior a la solicitud
  if (apr && dia(apr.fecha) < s.fecha_solicitud) {
    confirmaciones.push(
      h("RC9", `La aprobación (${dia(apr.fecha)}) es anterior a la solicitud (${s.fecha_solicitud}).`, "Confirmar que la aprobación corresponde a esta solicitud."),
    )
  }

  // RC5 — cotización vs solicitud (tolerancia 2 %)
  if (!p.cotizacion) {
    confirmaciones.push(h("RC5", "El paquete no trae cotización del proveedor.", "Pedir la cotización o confirmar que se crea la OC sin ella."))
  } else if (s.valor_total > 0) {
    const desvio = Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total
    if (desvio > TOLERANCIA_COTIZACION) {
      confirmaciones.push(
        h(
          "RC5",
          `La cotización suma ${COP(p.cotizacion.total)} y la solicitud ${COP(s.valor_total)} (diferencia ${(desvio * 100).toFixed(1)} %, tolerancia 2 %).`,
          "Confirmar con el solicitante cuál valor es el correcto antes de crear la OC.",
        ),
      )
    }
  }

  // RC6 — indicador de IVA (derivable del proveedor, con confirmación)
  const ivaValido = (c: string) => m.indicadoresIva.some((i) => i.codigo === c)
  if (s.indicador_iva === undefined) {
    if (prov) {
      derivados.indicador_iva = { valor: prov.indicador_iva_default, origen: "derivado" }
      confirmaciones.push(
        h("RC6", `La solicitud no informa indicador de IVA. Se propone ${prov.indicador_iva_default} (default del proveedor).`, "Confirmar el indicador de IVA propuesto."),
      )
    }
  } else if (!ivaValido(s.indicador_iva)) {
    bloqueos.push(h("RC6", `El indicador de IVA "${s.indicador_iva}" no existe en el maestro.`, "Pedir al solicitante un indicador válido."))
  } else derivados.indicador_iva = { valor: s.indicador_iva, origen: "solicitud" }

  // RC7 — condiciones de pago (derivable del proveedor, solo se informa)
  const pagoValido = (c: string) => m.condicionesPago.some((x) => x.codigo === c)
  if (s.condiciones_pago === undefined) {
    if (prov) derivados.condiciones_pago = { valor: prov.condiciones_pago_default, origen: "derivado" }
  } else if (!pagoValido(s.condiciones_pago)) {
    bloqueos.push(h("RC7", `La condición de pago "${s.condiciones_pago}" no existe en el maestro.`, "Pedir al solicitante una condición válida."))
  } else derivados.condiciones_pago = { valor: s.condiciones_pago, origen: "solicitud" }

  // RC8 — factura anterior a la solicitud = OC retroactiva
  const retroactiva = p.factura !== null && p.factura.fecha < s.fecha_solicitud
  if (retroactiva && p.factura) {
    confirmaciones.push(
      h(
        "RC8",
        `La factura ${p.factura.numero} (${p.factura.fecha}) es anterior a la solicitud (${s.fecha_solicitud}): OC retroactiva.`,
        "Confirmar la creación y registrar el desvío; sugerir al solicitante crear la OC antes de recibir la factura.",
      ),
    )
  }

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva }
}
