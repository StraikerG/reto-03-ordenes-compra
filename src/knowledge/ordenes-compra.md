# Conocimiento del proceso: órdenes de compra

Este documento se agrega al prompt del agente en tiempo de ejecución. El **comportamiento** vive en `agent/prompt.md`; aquí está el **conocimiento del proceso** que cambia con el negocio; la **ejecución** está en `src/tools/`.

## Qué es un paquete

Cada compra llega con tres piezas: solicitud (Excel), cotización del proveedor y el correo de aprobación del líder. Hay una OC por solicitud y se crea una OC por cada factura que entra a la compañía. Si el paquete trae factura, se considera un caso de posible OC retroactiva.

## Controles (RC)

| Código | Control | Tipo |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre) y está activo | Bloqueo |
| RC2 | Hay aprobación, dice "Aprobado" y viene de un aprobador del centro de costo | Bloqueo |
| RC3 | El valor total no supera el tope del aprobador | Bloqueo |
| RC4 | La subárea pertenece al centro de costo | Bloqueo |
| RC5 | Cotización vs solicitud: diferencia ≤ 2 %; sin cotización también se confirma | Confirmación |
| RC6 | Indicador de IVA ausente: se propone el del proveedor | Confirmación + derivado |
| RC7 | Condiciones de pago ausentes: se toman del proveedor | Derivado (se informa) |
| RC8 | Factura anterior a la solicitud: OC retroactiva | Confirmación |
| RC9 | Aprobación con fecha anterior a la solicitud | Confirmación |
| RC10 | cantidad × valor unitario = valor total (± 1) | Bloqueo |

## Vocabulario

- **Bloqueo**: impide crear la OC; se devuelve al humano con la acción sugerida.
- **Confirmación**: la OC es posible, pero la analista debe aceptar la excepción de forma explícita; queda registrada en la OC.
- **Derivado**: valor que el agente completó desde un maestro; siempre se informa.
- **Retroactiva**: la factura es anterior a la solicitud. Se crea solo con confirmación y se marca para medición en `out/control.csv`.
- **Idempotencia**: pedir dos veces la misma solicitud devuelve la OC ya creada.

## Sobre la OC retroactiva (para explicar a la dirección)

Crear la OC después de la factura salta la cotización y el control previo del gasto. El agente no lo impide (la factura ya existe) pero lo registra, para poder medir qué porcentaje de OC son retroactivas y por qué centros de costo o proveedores ocurre.
