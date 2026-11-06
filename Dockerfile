# md-semantic-search — production image (issue #126)
# Multi-stage: build TypeScript in a full toolchain, ship a slim runtime with
# only prod deps + dist. Runs as non-root; model cache and notes are volumes.
#
# issue #252: base images are pinned by digest (the last unpinned supply-chain
# input — everything else is SHA-pinned per #231). Dependabot's docker
# ecosystem bumps the digest as a reviewed PR; docs/deploy.md notes the
# refresh policy. The runtime stage does NOT carry src/ — bin/cli.mjs imports
# only ../dist, and the packed npm artifact proves the shipped surface.

# ---- build stage ------------------------------------------------------------
# digest of node:22-alpine (multi-arch manifest list, resolved 2026-11-06)
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY bin ./bin
COPY integrations ./integrations
RUN npm run build

# ---- runtime stage ----------------------------------------------------------
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
WORKDIR /app

ENV NODE_ENV=production \
    MDSS_CACHE_DIR=/cache \
    MDSS_HOST=127.0.0.1 \
    MDSS_PORT=8747

# non-root user; /cache and /notes mount points owned by it
RUN addgroup -S mdss && adduser -S mdss -G mdss \
    && mkdir -p /cache /notes /app/bin /app/dist \
    && chown -R mdss:mdss /cache /notes /app

COPY --from=build --chown=mdss:mdss /app/package.json /app/package-lock.json ./
COPY --from=build --chown=mdss:mdss /app/node_modules ./node_modules
COPY --from=build --chown=mdss:mdss /app/dist ./dist
COPY --from=build --chown=mdss:mdss /app/bin ./bin

# OCI metadata (issue #252) — registry listings show a bare image otherwise
LABEL org.opencontainers.image.title="md-semantic-search" \
      org.opencontainers.image.description="Local, private semantic search over Markdown — hybrid dense+BM25F, ANN, RAG, MCP. No API keys, no cloud." \
      org.opencontainers.image.source="https://github.com/chelslava/md-semantic-search" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.url="https://github.com/chelslava/md-semantic-search/pkgs/container/md-semantic-search" \
      org.opencontainers.image.documentation="https://github.com/chelslava/md-semantic-search/blob/main/docs/deploy.md"

USER mdss

EXPOSE 8747
VOLUME ["/cache", "/notes"]

HEALTHCHECK --interval=30s --timeout=4s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MDSS_PORT||8747)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "bin/cli.mjs"]
CMD ["serve", "--db", "/notes"]
