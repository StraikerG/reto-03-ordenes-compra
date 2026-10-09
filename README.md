# Reto 03 · Agente de órdenes de compra

Agente conversacional en **TypeScript + Bun** que valida solicitudes de compra, aplica controles RC1–RC10, solicita confirmación humana para excepciones y crea órdenes en un SAP simulado.

La solución separa el modelo de lenguaje de la lógica de negocio:

- **Gemini**: conversación y selección de herramientas.
- **TypeScript + Zod**: controles, cálculos, idempotencia y autorizaciones.
- **SAP simulado**: órdenes, auditoría, trazabilidad y `control.csv`.
- **`demo.ts`**: verificación determinista de los seis casos sin usar IA.

## Requisitos

- Bun 1.4 o superior.
- Una clave de Gemini para usar el chat.
- Docker Desktop, opcional.

## Inicio rápido

Instalar dependencias:

```bash
bun install
```

Crear configuración local:

```powershell
Copy-Item .env.example .env
```

Configurar `.env`:

```dotenv
LLM_PROVIDER=gemini
GEMINI_API_KEY=tu_clave_local
GEMINI_MODEL=gemini-3.6-flash
PORT=3000
```

> `.env` contiene secretos, está excluido de Git y no debe compartirse.

Ejecutar la verificación determinista:

```bash
bun run demo
```

Ejecutar chequeo de tipos y pruebas:

```bash
bun run typecheck
bun run tests/agente.check.ts
```

Iniciar el servidor:

```bash
bun run src/server.ts
```

Abrir la aplicación en:

```text
http://localhost:3000
```

Comprobar estado:

```text
GET /api/health
```

## Casos cubiertos por `demo.ts`

| Caso | Resultado esperado |
|---|---|
| `sol-001` | Crea OC e identifica reintentos idempotentes |
| `sol-002` | Bloquea proveedor inexistente, RC1 |
| `sol-003` | Bloquea aprobación inválida, RC2 |
| `sol-004` | Solicita confirmación por diferencia de cotización, RC5 |
| `sol-005` | Detecta compra retroactiva, RC8 |
| `sol-006` | Deriva IVA y condiciones de pago cuando corresponde |

Las salidas de ejecución se escriben en `out/`:

```text
out/control.csv
out/log.jsonl
out/sap/ordenes.jsonl
out/<caso>/trazabilidad.json
```

## Arquitectura

```text
agent/prompt.md
       │
       ▼
src/agent.ts
       │
       ├── src/llm/factory.ts
       │       ├── gemini.ts
       │       └── anthropic.ts (fallback)
       ├── src/tools/oc.ts
       ├── src/domain/
       ├── src/sap/
       └── src/server.ts ──► web/index.html
```

Estructura principal:

```text
agent/          Prompt del sistema
fixtures/       Maestros y solicitudes simuladas
src/domain/     Reglas RC1–RC10
src/tools/      Herramientas tipadas con Zod
src/llm/        Adaptadores de modelos
src/sap/        SAP simulado
web/            Frontend de chat
tests/          Pruebas del agente
demo.ts         Verificación determinista
SOLUCION.md     Documentación técnica detallada
```

## Docker

Construir la imagen:

```bash
docker build -t reto-03-ordenes-compra:local .
```

Ejecutar el contenedor:

```powershell
docker run --rm `
  --name reto-03-local `
  --env-file .\.env `
  -p 3000:3000 `
  reto-03-ordenes-compra:local
```

El contenedor ejecuta la aplicación con el usuario no-root `bun` y verifica automáticamente `GET /api/health`.

## Seguridad y controles

- La clave de Gemini se usa solamente en el backend.
- El modelo no crea órdenes directamente: solo solicita herramientas.
- RC1–RC10 se ejecutan en código determinista.
- Las excepciones requieren confirmación humana registrada.
- Se aplican límites de iteraciones, tokens, longitud de mensaje y solicitudes por IP.
- La creación de órdenes conserva evidencia y trazabilidad.

## Despliegue público

Aplicación disponible en Render:

```text https://reto-03-ordenes-compra-opl6.onrender.com
```

## Documentación técnica

Consulta [SOLUCION.md](./SOLUCION.md) para la arquitectura detallada, la matriz de controles, el ciclo del agente, el diseño de un adaptador SAP real y el análisis de órdenes retroactivas.
