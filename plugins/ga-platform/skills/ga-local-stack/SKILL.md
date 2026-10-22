---

name: ga-local-stack
description: Run, observe and debug the whole global-architecture system locally - pnpm stack:up/down with PM2 and local Postgres, db:setup and migrations, dev TLS certificates, watch mode, logs with request ids, gRPC reflection with buf curl, health checks, OpenTelemetry tracing, Docker images, and troubleshooting (ports, pnpm release-age gate, PM2, Postgres roles). Use it whenever someone wants to start, restart, inspect or debug services locally, reproduce a bug across services, read logs, call a gRPC method by hand, or when something fails to boot.
---

# Local stack

Everything runs as plain Node processes under PM2 against a local Postgres; no Docker
or cloud needed. Node 26 and pnpm 12 are pinned by `devEngines` and downloaded by pnpm.

## First run

```bash
pnpm install          # also installs the pinned Node 26 into node_modules/.bin
pnpm stack:up         # build -> certs -> db:setup -> migrations -> PM2 -> wait for /readyz
pnpm test:e2e         # prove it works end to end
```

`pnpm stack:up` prints the URLs: API `https://localhost:8443/v1/...`, docs
`https://localhost:8443/docs`, each service's gRPC address. Everything binds to 127.0.0.1.

Prerequisite: a Postgres you can reach as a superuser (`PG_ADMIN_URL`, default
`postgresql://$USER@localhost:5432/postgres`). `pnpm db:setup` then creates the `ga`
role (password `ga`), one database per service from `services.json`, `ga_test`, and any
declared extensions. No local Postgres? Any Postgres 16+ works; set `PG_ADMIN_URL` and
the services' `DATABASE_URL`s.

## Daily commands

```bash
pnpm stack:status                          # PM2 table
pnpm stack:logs                            # all logs (JSON lines)
pnpm exec pm2 logs booking-service         # one service
pnpm exec pm2 restart booking-service      # after `pnpm --filter @ga/booking-service build`
pnpm stack:down                            # stop and remove the processes
pnpm --filter @ga/house-service dev        # watch mode for one service (stop its PM2 process first)
```

The PM2 definition (`ecosystem.config.cjs`) is generated from `services.json`: a new
service registered by the generator is started automatically, with `GRPC_PORT`,
`DATABASE_URL` and every `*_SERVICE_URL` injected. Values in a service's `.env` are
used only for variables PM2 does not set.

## Following one request through the system

Send your own id and grep for it:

```bash
curl -s --cacert .certs/dev-cert.pem -H 'x-request-id: debug-42' https://localhost:8443/v1/users?pageSize=1
grep -h debug-42 ~/.pm2/logs/*-out.log
```

Each service logs one JSON line per RPC (`requestId`, `rpc.pattern`, `responseTime`,
`err` on failure); the gateway logs one line per HTTP request.

## Calling gRPC directly (reflection is on)

```bash
cd packages/contracts
pnpm exec buf curl --protocol grpc --http2-prior-knowledge http://127.0.0.1:50053 --list-methods
pnpm exec buf curl --protocol grpc --http2-prior-knowledge -d '{"service":""}' \
  http://127.0.0.1:50051/grpc.health.v1.Health/Check
pnpm exec buf curl --protocol grpc --http2-prior-knowledge -d '{"pageSize":5}' \
  http://127.0.0.1:50052/ga.house.v1.HouseService/ListHouses
```

grpcurl and Postman work too. Errors show `google.rpc.ErrorInfo` details.

## Tracing (off by default)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. a local Jaeger/Tempo/OTel collector on
`http://127.0.0.1:4318`) and `OTEL_SERVICE_NAME`; the `--import @ga/service-kit/telemetry`
flag every process already starts with then exports gRPC, HTTP, Postgres and Fastify spans
and injects trace ids into logs. Without the variable it does nothing.

## Containers

Each service has a `Dockerfile` (build from the repo root:
`docker build -f apps/user-service/Dockerfile .`): `pnpm deploy` of the service into a
distroless Node 26 image, non-root. The image does not run migrations; run
`node dist/migrate.js` as a release job. Container builds were not part of the verified
local flow; treat the Dockerfiles as the starting point for the infrastructure work.

## Troubleshooting

| Symptom                                                         | Cause / fix                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm install` fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION` | a version is younger than the 24 h `minimumReleaseAge`; pin the previous version in the catalog  |
| `ERR_PNPM_IGNORED_BUILDS`                                       | a new dependency has an install script; decide in `allowBuilds` (pnpm-workspace.yaml)            |
| `npm` errors with `EBADDEVENGINES` inside the repo              | use pnpm; npm enforces `devEngines` and the system Node is older                                 |
| `Invalid configuration: - GRPC_PORT ...` at boot                | env validation; see the service's `src/config.ts` and `.env.example`                             |
| `/readyz` 503 with a service `UNREACHABLE`                      | that process is down or still starting: `pnpm exec pm2 logs <name> --lines 50`                   |
| service `NOT_SERVING`                                           | its `select 1` check fails: Postgres down or wrong `DATABASE_URL`                                |
| `cannot create a test schema` in tests                          | run `pnpm db:setup` (creates `ga_test`)                                                          |
| `EADDRINUSE`                                                    | another process holds the port: `lsof -nP -iTCP:<port> -sTCP:LISTEN`                             |
| gateway: `TLS is enabled but ... cannot be read`                | `pnpm certs`                                                                                     |
| browser warns about the certificate                             | install `mkcert` and run `pnpm certs --force` for a trusted cert                                 |
| `Nest can't resolve dependencies of X (?, ...)`                 | a constructor class was imported with `import type`, or a circular import; see `ga-architecture` |
| `does not provide an export named ...` at startup               | a type imported as a value; `pnpm build` runs `check-esm` to catch it                            |
