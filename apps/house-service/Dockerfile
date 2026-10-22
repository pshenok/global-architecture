# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/house-service/Dockerfile -t house-service .
# Migrations are a separate release step: run `node dist/migrate.js` with the same image.

FROM node:26-trixie-slim AS build
RUN npm install --global pnpm@12.15.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter "@ga/house-service..." \
 && pnpm --filter "@ga/house-service" deploy --prod --legacy /out

# Distroless: no shell, no package manager, non-root (uid 65532).
FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --from=build /out .
ENV NODE_ENV=production GRPC_HOST=0.0.0.0
EXPOSE 50052
# Probes: Kubernetes native gRPC probes against grpc.health.v1 on the gRPC port.
CMD ["--enable-source-maps", "--import", "@ga/service-kit/telemetry", "dist/main.js"]
