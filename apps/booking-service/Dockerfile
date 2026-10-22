# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/booking-service/Dockerfile -t booking-service .

FROM node:26-trixie-slim AS build
RUN npm install --global pnpm@12.15.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@ga/booking-service..." \
 && pnpm turbo run build --filter "@ga/booking-service..." \
 && pnpm deploy --filter "@ga/booking-service" --prod /out

# Distroless: no shell, no package manager, non-root (uid 65532).
FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --from=build /out .
ENV NODE_ENV=production
EXPOSE 50053
# Liveness/readiness: Kubernetes native gRPC probes against grpc.health.v1.
CMD ["--enable-source-maps", "--import", "@ga/service-kit/telemetry", "dist/main.js"]
