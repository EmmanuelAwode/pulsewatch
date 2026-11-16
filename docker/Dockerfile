# syntax=docker/dockerfile:1.7
#
# One multi-stage build for every PulseWatch image:
#
#   docker build -f docker/Dockerfile --target api     -t pulsewatch-api .
#   docker build -f docker/Dockerfile --target worker  -t pulsewatch-worker .
#   docker build -f docker/Dockerfile --target web     -t pulsewatch-web .
#   docker build -f docker/Dockerfile --target migrate -t pulsewatch-migrate .
#
# Everything is compiled once in the `build` stage. The runtime images then
# copy only what each process needs: production dependencies and compiled
# JavaScript, with no TypeScript sources and no development tooling.

ARG NODE_IMAGE=node:24-alpine

# --- Build ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /repo

# Manifests first, so the dependency layer is only rebuilt when they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# A self-contained folder per process: its compiled code plus production
# dependencies, with the workspace packages it uses copied in.
RUN pnpm deploy --filter @pulsewatch/api --prod --legacy /out/api \
 && pnpm deploy --filter @pulsewatch/worker --prod --legacy /out/worker

# --- Migrations (one-shot job) ----------------------------------------------
# Runs `prisma migrate deploy` and exits. It needs the Prisma CLI, a dev
# dependency, so it uses the build stage rather than a slim runtime image.
FROM build AS migrate
CMD ["pnpm", "db:migrate:deploy"]

# --- API --------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
# Never run as root: a compromised process gets an unprivileged user.
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz > /dev/null || exit 1
CMD ["node", "dist/server.js"]

# --- Worker -----------------------------------------------------------------
FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production METRICS_HOST=0.0.0.0 METRICS_PORT=9100
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9100/healthz > /dev/null || exit 1
CMD ["node", "dist/main.js"]

# --- Web (static files + reverse proxy) -------------------------------------
# nginx serves the compiled dashboard and forwards /api to the API, so the
# browser sees a single origin (no CORS, first-party cookies). The
# unprivileged image runs nginx as a non-root user on port 8080.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz > /dev/null || exit 1
