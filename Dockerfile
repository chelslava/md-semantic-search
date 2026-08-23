# md-semantic-search — production image (issue #126)
# Multi-stage: build TypeScript in a full toolchain, ship a slim runtime with
# only prod deps + dist. Runs as non-root; model cache and notes are volumes.

# ---- build stage ------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY bin ./bin
COPY integrations ./integrations
RUN npm run build

# ---- runtime stage ----------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    MDSS_CACHE_DIR=/cache \
    MDSS_HOST=127.0.0.1 \
    MDSS_PORT=8747

# non-root user; /cache and /notes mount points owned by it
RUN addgroup -S mdss && adduser -S mdss -G mdss \
    && mkdir -p /cache /notes /app/bin /app/dist /app/src \
    && chown -R mdss:mdss /cache /notes /app

COPY --from=build --chown=mdss:mdss /app/package.json /app/package-lock.json ./
COPY --from=build --chown=mdss:mdss /app/node_modules ./node_modules
COPY --from=build --chown=mdss:mdss /app/dist ./dist
COPY --from=build --chown=mdss:mdss /app/bin ./bin
COPY --from=build --chown=mdss:mdss /app/src ./src

USER mdss

EXPOSE 8747
VOLUME ["/cache", "/notes"]

HEALTHCHECK --interval=30s --timeout=4s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MDSS_PORT||8747)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "bin/cli.mjs"]
CMD ["serve", "--db", "/notes"]
