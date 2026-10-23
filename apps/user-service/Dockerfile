# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/user-service/Dockerfile -t user-service .
# Migrations are a separate release step: run `node dist/migrate.js` with the same image.

FROM node:26-trixie-slim AS build
RUN npm install --global pnpm@12.15.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter "@ga/user-service..." \
 && pnpm --filter "@ga/user-service" deploy --prod --legacy /out

# Distroless: no shell, no package manager, non-root (uid 65532).
FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --from=build /out .
ENV NODE_ENV=production GRPC_HOST=0.0.0.0
# Off loopback the service refuses plaintext gRPC: mount a certificate and set
# GRPC_TLS_CERT_FILE and GRPC_TLS_KEY_FILE (plus GRPC_TLS_CA_FILE for its own outbound calls).
EXPOSE 50051
# Probes: Kubernetes native gRPC probes against grpc.health.v1 on the gRPC port.
CMD ["--enable-source-maps", "--import", "@ga/service-kit/telemetry", "dist/main.js"]
