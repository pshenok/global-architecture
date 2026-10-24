# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/event-bus-service/Dockerfile -t event-bus-service .
# Migrations are a separate release step: run `node dist/migrate.js` with the same image.

FROM node:26-trixie-slim AS build
RUN npm install --global pnpm@12.15.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter "@ga/event-bus-service..." \
 && pnpm --filter "@ga/event-bus-service" deploy --prod --legacy /out

# Distroless: no shell, no package manager, non-root (uid 65532).
FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --from=build /out .
ENV NODE_ENV=production GRPC_HOST=0.0.0.0 GRPC_HEALTH_PORT=8081
# Off loopback the service refuses plaintext gRPC: mount this workload's own certificate and
# set GRPC_TLS_CERT_FILE and GRPC_TLS_KEY_FILE (plus GRPC_TLS_CA_FILE for its own outbound
# calls). They are read at start: roll the pods to renew them, well before they expire.
# Identity (ADR-0004): mount this workload's private key (a secret) and the shared public key
# map, and set WORKLOAD_KEY_FILE and WORKLOAD_KEYS_FILE.
EXPOSE 50050
EXPOSE 8081
# Probes: Kubernetes native gRPC probes (`grpc: { port: 8081 }`) against grpc.health.v1 on
# GRPC_HEALTH_PORT, which serves health alone in plaintext: kubelet cannot speak TLS.
CMD ["--enable-source-maps", "--import", "@ga/service-kit/telemetry", "dist/main.js"]
