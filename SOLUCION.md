# SOLUCION.md — Reto 03 · Agente de órdenes de compra

## 1. Objetivo

La solución automatiza la lectura de solicitudes de compra, aplica controles RC1–RC10, solicita confirmación humana ante excepciones y crea órdenes de compra en un SAP simulado con trazabilidad verificable.

El modelo de lenguaje no decide controles ni escribe directamente en SAP. Su función es conversar y solicitar herramientas; la validación y la creación de la orden permanecen en código TypeScript determinista.

## 2. Arquitectura

```text
web/index.html
     │ HTTP
     ▼
src/server.ts
     │
     ├── src/agent.ts
     │     ├── agent/prompt.md
     │     ├── src/knowledge/ordenes-compra.md
     │     └── ciclo: modelo → herramientas → modelo
     │
     ├── src/llm/adapter.ts
     │     └── src/llm/factory.ts
     │           ├── src/llm/gemini.ts
     │           └── src/llm/anthropic.ts (fallback)
     │
     ├── src/tools/oc.ts (Zod)
     ├── src/domain/ (reglas y payload)
     └── src/sap/mock.ts

fixtures/  → maestros y casos de prueba, solo lectura
out/       → control.csv, trazabilidad, logs y SAP simulado
```

| Capa | Responsabilidad |
|---|---|
| `agent/prompt.md` | Comportamiento conversacional y uso esperado de herramientas. |
| `src/knowledge/` | Conocimiento funcional incluido en el prompt del sistema. |
| `src/tools/oc.ts` | Herramientas tipadas con Zod y frontera de ejecución. |
| `src/domain/` | Reglas RC1–RC10, derivaciones y construcción del payload. |
| `src/sap/` | Contrato SAP y simulación persistida en JSONL. |
| `src/llm/` | Adaptadores de proveedores sin acoplar el agente a un modelo. |

## 3. Ciclo del agente

1. El usuario envía un mensaje al chat.
2. `src/agent.ts` agrega el prompt del sistema y envía el historial al adaptador LLM.
3. El modelo solicita una o más herramientas.
4. El backend valida argumentos con Zod y ejecuta las herramientas.
5. Las herramientas releen los fixtures desde la fuente; no confían en objetos enviados por el modelo.
6. Los resultados se devuelven al modelo para que explique el resultado al usuario.
7. Si hay excepciones, el servidor marca el caso como pendiente y exige confirmación en el turno siguiente.

Guardrails implementados:

- `MAX_ITER` limita pasos por turno.
- `MAX_TOKENS_SESSION` y `MAX_TOKENS_GLOBAL` limitan consumo.
- La confirmación humana se valida en el servidor, no solo en el prompt.
- Los errores del proveedor se devuelven de forma legible sin perder el estado de la sesión.
- Las llamadas a herramientas se muestran en el frontend y se registran en `out/log.jsonl`.

## 4. Elección e integración del modelo

La implementación validada utiliza **Google Gemini** mediante REST nativo con `fetch`.

| Elemento | Implementación |
|---|---|
| Proveedor principal | Gemini |
| Modelo configurado | `gemini-3.5-flash-lite` |
| Clave | `GEMINI_API_KEY`, solo backend |
| Adaptador | `src/llm/gemini.ts` |
| Selector | `src/llm/factory.ts` |
| Fallback | `src/llm/anthropic.ts` |

Se eligió un modelo Flash porque el modelo solo orquesta herramientas y redacta explicaciones. Los controles, cálculos, derivaciones, idempotencia y autorización se ejecutan fuera del modelo.

El adaptador Gemini implementa tres detalles relevantes:

1. Convierte el historial interno al formato `generateContent`.
2. Elimina campos de JSON Schema que Gemini no admite en `functionDeclarations`, como `additionalProperties`.
3. Conserva `thoughtSignature` en cada `functionCall`, necesaria para continuar correctamente el ciclo de herramientas con Gemini.

### Costos y medición

`demo.ts` ejecuta los seis casos directamente sobre las herramientas y no consume un modelo de lenguaje; su costo de IA es cero.

El chat registra tokens de entrada y salida por sesión. El costo monetario debe calcularse con el consumo observado y la tarifa vigente del modelo configurado. No se reporta una cifra fija para evitar presentar costos no medidos.

La solución limita el uso con topes de tokens, iteraciones, tiempo de espera, longitud de mensaje y solicitudes por IP.

## 5. Matriz de controles

Todos los controles se implementan en `src/domain/reglas.ts`.

| Control | Regla | Resultado | Caso demostrado |
|---|---|---|---|
| RC1 | Proveedor existe, coincide por NIT/nombre y está activo. | Bloqueo | `sol-002` |
| RC2 | Existe aprobación explícita de un aprobador autorizado del centro. | Bloqueo | `sol-003` |
| RC3 | El valor no supera el tope del aprobador autorizado. | Bloqueo | — |
| RC4 | La subárea pertenece al centro de costo. | Bloqueo | — |
| RC5 | Diferencia cotización/solicitud superior a 2 %, o cotización ausente. | Confirmación | `sol-004` |
| RC6 | IVA válido; si falta, se deriva el default del proveedor. | Bloqueo o confirmación | `sol-006` |
| RC7 | Condición de pago válida; si falta, se deriva el default del proveedor. | Bloqueo o derivación | `sol-006` |
| RC8 | Factura anterior a la solicitud: OC retroactiva. | Confirmación | `sol-005` |
| RC9 | La aprobación no puede ser anterior a la solicitud. | Confirmación | — |
| RC10 | `cantidad × valor_unitario` coincide con `valor_total`, tolerancia ±1. | Bloqueo | — |

Controles adicionales: moneda permitida, centro de costo existente, NIT de cotización consistente y códigos de IVA/pago presentes en maestros.

## 6. Diseño del adaptador SAP real

El reto utiliza `SapMock`, que persiste órdenes en `out/sap/ordenes.jsonl`. En producción, `SapAdapter` debe mantenerse como frontera técnica y reemplazarse por una implementación real.

### Propuesta

- Integración con una API OData de Purchase Orders de SAP S/4HANA, publicada detrás de SAP API Management o Integration Suite.
- Para escenarios ECC sin OData disponible, usar BAPI/RFC mediante middleware corporativo.
- Credenciales mediante OAuth 2.0 o cuenta técnica de mínimo privilegio; secretos en un gestor como Azure Key Vault, AWS Secrets Manager o SAP BTP Destination Service.

### Mapeo funcional

| Payload interno | Destino SAP esperado |
|---|---|
| proveedor | Supplier / Vendor |
| sociedad | Company Code |
| organización de compras | Purchasing Organization |
| condiciones de pago | Payment Terms |
| posiciones | Ítems de la OC |
| centro de costo | Account Assignment / Cost Center |
| IVA | Tax Code |
| solicitud, aprobación y hash | Referencia externa o campos de auditoría acordados |

Los nombres exactos de servicios y campos deben validarse con el equipo SAP del cliente antes de producción.

### Reglas de integración

- Consultar por `solicitud_id` antes de crear una OC para mantener idempotencia.
- Ante timeout o error transitorio, consultar primero si SAP creó la OC antes de reintentar.
- Registrar número de OC, fecha, excepción confirmada y hash de evidencia.
- No reenviar automáticamente errores funcionales o validaciones SAP.
- Aplicar observabilidad, alertas, timeouts y circuit breaker.

## 7. Análisis de órdenes retroactivas

Una OC creada después de la factura no evita el gasto: lo formaliza cuando el compromiso ya ocurrió. Esto reduce la efectividad de controles como presupuesto, aprobación previa, selección de proveedor y negociación.

La solución no oculta este desvío. Cuando detecta una factura anterior a la solicitud:

- marca la OC como retroactiva;
- exige confirmación humana explícita;
- registra la excepción en `control.csv`;
- preserva evidencia y trazabilidad.

En producción, este dato debe convertirse en un indicador por área, proveedor, centro de costo y aprobador. La medida correctiva no es solo regularizar la OC: debe facilitarse que la solicitud, cotización y aprobación ocurran antes de recibir factura.

## 8. Decisiones y trade-offs

1. **Herramientas como fuente de verdad.** El modelo no puede alterar maestros, solicitud ni payload: las herramientas recargan datos desde fixtures.
2. **Confirmación en servidor.** El prompt orienta; el servidor hace cumplir la confirmación y evita que el modelo salte excepciones.
3. **Validación determinista.** La cotización se interpreta con parser/heurísticas; no se delegan controles financieros a un LLM.
4. **Adaptador REST directo.** Reduce dependencias y permite inspeccionar el intercambio de herramientas.
5. **Mock con JSONL.** Adecuado para demostración, no para múltiples réplicas ni producción.

## 9. Supuestos y límites

- Los fixtures representan datos normalizados de correo, solicitud, cotización, aprobación y factura.
- La idempotencia se basa en `solicitud_id`.
- La confirmación se registra como `analista (chat)` porque el reto no incluye autenticación corporativa.
- La unidad de medida y la descripción pueden derivarse de la cotización; en producción deben validarse contra maestros SAP.
- El SAP simulado y `out/` son persistencia local de demostración; en Render, el almacenamiento es efímero salvo que se configure persistencia externa.

## 10. Cobertura y validación ejecutada

| Verificación | Resultado |
|---|---|
| `bun run demo` | Procesa los seis casos sin LLM. |
| `bun run typecheck` | Validación TypeScript sin emisión. |
| `bun run tests/agente.check.ts` | Confirmación humana, límites, errores y API. |
| Chat con Gemini | Validado con herramientas para `sol-001`. |
| Docker | Imagen construida y `/api/health` respondió correctamente. |

## 11. Uso de IA

Se utilizó IA generativa como apoyo técnico para orientar la configuración local, la integración REST con Gemini, la depuración de esquemas de herramientas y `thoughtSignature`, y la preparación de borradores de documentación.

La IA no reemplazó la validación de la solución. Se ejecutaron pruebas deterministas, chequeo de tipos, pruebas del agente, validación real de Gemini y prueba del contenedor Docker.

Gemini se utiliza en tiempo de ejecución únicamente como capa conversacional y orquestador de herramientas. Las reglas RC1–RC10, confirmaciones, idempotencia, auditoría y creación de la OC se implementan en TypeScript.

## 12. Riesgos para producción

| Riesgo | Mitigación |
|---|---|
| El modelo inventa o modifica datos | Las herramientas releen fuentes y validan con Zod. |
| El modelo intenta omitir confirmación | El servidor mantiene estado de pendientes y valida el turno siguiente. |
| Formatos reales de cotización varían | Ampliar parser o incorporar extracción con validación determinista posterior. |
| Falla de integración SAP | Timeouts, consulta por referencia, reintentos controlados y circuit breaker. |
| Uso excesivo del proveedor LLM | Límites por turno, sesión, proceso e IP. |
| Estado local no compartido | Migrar sesiones, auditoría y persistencia a servicios compartidos. |
| Prompt injection en adjuntos | Los controles críticos no dependen del modelo; la creación se gobierna por herramientas. |

## Despliegue público

La aplicación se desplegó como Web Service Docker en Render.

- Chat público: `https://reto-03-ordenes-compra-opl6.onrender.com`
- Health check: `https://reto-03-ordenes-compra-opl6.onrender.com/api/health`
- Runtime: Bun dentro de contenedor Docker.
- Proveedor LLM: Gemini, configurado mediante variables de entorno de Render.
- Endpoint de salud: `GET /api/health`.

El servicio se validó al quedar en estado `Live` en Render.
