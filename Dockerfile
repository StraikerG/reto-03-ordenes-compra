FROM oven/bun:1

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

# Copiar manifiestos primero para aprovechar la caché.
COPY --chown=bun:bun package.json bun.lock ./

# WORKDIR /app se crea como root; permitir que bun cree node_modules.
RUN chown -R bun:bun /app

# Instalar dependencias sin privilegios.
USER bun
RUN bun install --frozen-lockfile --production

# Copiar aplicación, prompt, fixtures y frontend.
COPY --chown=bun:bun . .

# Directorio para SAP simulado, control.csv, logs y trazabilidad.
RUN mkdir -p /app/out

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/server.ts"]