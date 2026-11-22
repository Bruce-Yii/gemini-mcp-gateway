# Production image for the standalone CLI gateway.
# No secrets are baked into layers: config and tokens are supplied at runtime.
# Requires Node >= 20.19.0 (package.json `engines`); node:20 and node:22 tags both work.
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies from the lockfile. package.json has no
# devDependencies, so --omit=dev is safe and keeps test/build tooling out.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Runtime source only. The gateway config is not baked in: it is mounted
# read-only at /app/gateway-config.json. There is no `config/` directory in
# this repo (the CLI reads --config), so only src/ and api/ are copied.
COPY --chown=node:node src ./src
COPY --chown=node:node api ./api

# Capture output directory (see CAPTURE_FILE_DIR in docs/OPEN-SOURCE/DOCKER.md).
RUN mkdir -p /app/work/capture && chown -R node:node /app/work

USER node
EXPOSE 3000

# There is no /healthz route on the CLI/standalone path (that route lives only
# in the Vercel entry, src/vercel-app.js). Probe the TCP listener instead;
# /mcp returns 400/405 for a bare GET, which is NOT a health signal.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const s=require('net').connect({host:'127.0.0.1',port:Number(process.env.PORT||3000)},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>{s.destroy();process.exit(1)},2000)"

# --host 0.0.0.0 is required so the container port is reachable from outside.
CMD ["node", "src/server.js", "--config", "/app/gateway-config.json", "--host", "0.0.0.0", "--port", "3000"]
