# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/gateway/Dockerfile -t gateway .
# Behind a TLS-terminating ingress run with TLS_ENABLED=false; otherwise mount a
# certificate and set TLS_CERT_FILE / TLS_KEY_FILE.

FROM node:26-trixie-slim AS build
RUN npm install --global pnpm@12.15.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter "@ga/gateway..." \
 && pnpm --filter "@ga/gateway" deploy --prod --legacy /out

FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --from=build /out .
ENV NODE_ENV=production GATEWAY_HOST=0.0.0.0
# Calls to services off loopback use TLS: mount their CA and set GRPC_TLS_CA_FILE.
EXPOSE 8443
CMD ["--enable-source-maps", "--import", "@ga/service-kit/telemetry", "dist/main.js"]
