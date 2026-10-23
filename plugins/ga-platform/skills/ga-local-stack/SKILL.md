---

name: ga-local-stack
description: Run, observe and debug the whole global-architecture system locally - pnpm stack:up/down with PM2 and local Postgres, db:setup (and --reset) and migrations, dev TLS certificates and the gRPC CA, workload keys and their rotation, the local dev IdP and access tokens (pnpm dev:token), registering and granting admin, calling RPCs with pnpm grpc:call and buf curl over TLS, watch mode, logs with request ids, health checks, OpenTelemetry tracing, Docker images, and troubleshooting (ports, pnpm release-age gate, PM2, Postgres roles, 401/403/503 auth errors, CALLER_*/PRINCIPAL_* rejections, TLS and key errors). Use it whenever someone wants to start, restart, inspect or debug services locally, get a token, reproduce a bug across services, read logs, call a gRPC method by hand, or when something fails to boot.
---

# Local stack

Everything runs as plain Node processes under PM2 against a local Postgres; no Docker
or cloud needed. Node 26 and pnpm 12 are pinned by `devEngines` and downloaded by pnpm.

## First run

```bash
pnpm install          # also installs the pinned Node 26 into node_modules/.bin
pnpm stack:up         # build -> .env files -> certs -> keys -> db:setup -> migrations -> PM2 -> wait until ready
pnpm test:e2e         # prove it works end to end
```

`pnpm stack:up` creates what is missing in `.certs/` (git-ignored): the gateway's HTTPS
certificate, a local gRPC CA with a server certificate for `localhost` (`pnpm certs`), and
an Ed25519 key per workload plus the public key map (`pnpm keys`). PM2 runs every service,
the gateway and `dev-idp`, a local OIDC provider on `http://127.0.0.1:8090`
(`services.json` `devIdp.port`) that signs any subject it is asked for; it listens on
loopback only and refuses `NODE_ENV=production`. The command waits until every service is
SERVING and the gateway's `/readyz` is 200 with `identityProvider: "ok"` (its IdP keys
are loaded), then prints the URLs: API `https://localhost:8443/v1/...`, docs
`https://localhost:8443/docs`, each service's `grpcs://localhost:<port>`. Everything binds
to 127.0.0.1, and gRPC runs TLS on every hop.

Prerequisite: Postgres 16+ on `localhost:5432` with a superuser login (`PG_ADMIN_URL`,
default `postgresql://$USER@localhost:5432/postgres`). `pnpm db:setup` creates missing
`apps/*/.env` files from `.env.example`, the `ga` role (password `ga`), one database per
service from `services.json`, `ga_test`, and any declared extensions. The stack, the
migrations and the tests always connect as `ga:ga@localhost:5432`, so a Postgres
elsewhere (another host or port, Docker on 5433) needs a port forward to
`localhost:5432`; changing `PG_ADMIN_URL` alone splits the setup across two servers.
`pnpm db:setup --reset ga_booking --yes` drops and recreates the named local databases
(dev data only; refused for a non-local Postgres or in production); run `pnpm stack:up`
afterwards to migrate them.

## Signing in

Every API route except the health probes, the house catalogue and registration needs a
registered user (`/docs` and `/openapi.json` are open).

```bash
TOKEN=$(pnpm -s dev:token alice --email alice@example.com)   # 900 s; --ttl <s>, --unverified
curl -s --cacert .certs/dev-cert.pem -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"fullName":"Alice"}' https://localhost:8443/v1/users
curl -s --cacert .certs/dev-cert.pem -H "authorization: Bearer $TOKEN" https://localhost:8443/v1/users/me
pnpm users:grant-role <userId> admin    # roles live in user-service, never in the IdP
```

- Register each new login once (`POST /v1/users` -> 201 with the user's `id`). It needs a
  verified email, so pass `--email` to `dev:token`; without it registration answers 403
  `EMAIL_NOT_VERIFIED`.
- A granted role reaches requests when the gateway's identity cache refreshes (up to
  60 s, `IDENTITY_CACHE_TTL_S`).

## Daily commands

```bash
pnpm stack:status                          # PM2 table
pnpm stack:logs                            # all logs (JSON lines)
pnpm exec pm2 logs booking-service         # one service (dev-idp too)
pnpm exec pm2 restart booking-service      # after `pnpm turbo run build --filter=@ga/booking-service...`
                                           # (the `...` also rebuilds kit/contracts/kernel if you changed them)
pnpm stack:down                            # stop and remove the processes
pnpm --filter @ga/house-service dev        # watch mode for one service (stop its PM2 process first)
```

The PM2 definition (`ecosystem.config.cjs`) is generated from `services.json`: a new
service registered by the generator is started automatically, with `GRPC_PORT`,
`DATABASE_URL`, every `*_SERVICE_URL` (`localhost:<port>`), the gRPC TLS files and its
workload key files injected; the gateway also gets `AUTH_ISSUERS` pointing at the dev IdP.
Values in a service's `.env` are used only for variables PM2 does not set.

## Following one request through the system

Send your own id and grep for it:

```bash
curl -s --cacert .certs/dev-cert.pem -H 'x-request-id: debug-42' 'https://localhost:8443/v1/houses?pageSize=1'
grep -h debug-42 ~/.pm2/logs/*-out.log
```

Each service logs one JSON line per RPC (`requestId`, `rpc.pattern`, `responseTime`,
`caller`, `userId` when there is a user, `err` on failure); the gateway logs one line per
HTTP request. The `authorization` header and `x-ga-*` metadata are redacted.

## Calling gRPC directly

```bash
pnpm grpc:call house-service ListHouses '{"pageSize":5}'                 # as the gateway, no user
pnpm grpc:call booking-service ListBookings '{"party":"BOOKING_PARTY_HOST"}' --as <userId>
pnpm grpc:call user-service ListUsers '{}' --as <userId> --admin
pnpm grpc:call user-service ResolveIdentity '{}' --identity alice
pnpm grpc:call user-service GetUser '{"id":"<userId>"}' --as <userId> --caller house-service
```

`grpc:call` connects over TLS and signs what the platform would: a caller assertion
(`--caller`, default `gateway`) and, with `--as` or `--identity`, a principal signed with
the gateway's local key. Failures print the code and the decoded reason. It uses the keys
in `.certs/` and refuses `NODE_ENV=production`.

Reflection and health checks need no tokens, so buf curl works for them (with the CA):

```bash
cd packages/contracts
pnpm exec buf curl --protocol grpc --cacert ../../.certs/grpc-ca.pem https://localhost:50053 --list-methods
pnpm exec buf curl --protocol grpc --cacert ../../.certs/grpc-ca.pem -d '{"service":""}' \
  https://localhost:50051/grpc.health.v1.Health/Check
```

buf curl on an RPC gets `UNAUTHENTICATED` (`CALLER_MISSING`); use `grpc:call`. Errors carry
`google.rpc.ErrorInfo` details; buf curl shows the detail type and a base64 `value`, while
`grpc:call`, the gateway's problem+json and the `grpcError()` test helper decode reason,
domain and metadata.

`GRPC_TRACE=server_call` (or `all`) with `GRPC_VERBOSITY=DEBUG` makes grpc-js print every
received metadata entry, including the `x-ga-caller` and `x-ga-principal` tokens. Use it
on your machine only and never paste its output into tickets or shared logs.

## Keys and certificates

```bash
pnpm certs [--force]                     # HTTPS certificate, gRPC CA + server certificate
pnpm keys                                # missing keys for the gateway and every registered service
pnpm keys --rotate house-service         # publish a new public key, wait 65 s, replace the private key
pnpm keys --prune house-service          # drop its old public keys (refused within 130 s of a rotation)
curl -s -X POST http://127.0.0.1:8090/rotate   # new dev IdP signing key; the gateway fetches it on first use
```

Every workload re-reads `.certs/workload-keys.json` and its own private key every 60 s,
so a rotation needs no restart: the rotated workload logs `now signs with key ...` once it
switches. The production runbook is in `ga-platform-maintenance`.

## Tracing (off by default)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. a local Jaeger/Tempo/OTel collector on
`http://127.0.0.1:4318`); every process (PM2, `pnpm dev`, containers) starts with
`--import @ga/service-kit/telemetry`, which then exports gRPC, HTTP, Postgres and Fastify
spans and injects trace ids into logs. Without the variable it does nothing. Put it in the
app's `.env` (PM2 sets `OTEL_SERVICE_NAME` but not the endpoint, so the `.env` value
applies) and restart the process.

## Containers

Each service has a `Dockerfile` (build from the repo root:
`docker build -f apps/user-service/Dockerfile .`): `pnpm deploy --prod --legacy` of the
service into a distroless Node 26 image, non-root, `GRPC_HOST=0.0.0.0`. Off loopback the
service refuses plaintext gRPC, so running it needs mounted certificate files
(`GRPC_TLS_CERT_FILE`, `GRPC_TLS_KEY_FILE`, plus `GRPC_TLS_CA_FILE` for its own calls) and
its workload keys (`WORKLOAD_KEY_FILE`, a secret, and `WORKLOAD_KEYS_FILE`), besides
`DATABASE_URL`. The image does not run migrations; run `node dist/migrate.js` with the
same image as a release job.

## Troubleshooting

| Symptom                                                                                            | Cause / fix                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`                                    | a version is younger than the 24 h `minimumReleaseAge`; pin the previous version in the catalog                                                                             |
| `ERR_PNPM_IGNORED_BUILDS`                                                                          | a new dependency has an install script; decide in `allowBuilds` (pnpm-workspace.yaml)                                                                                       |
| `npm` errors with `EBADDEVENGINES` inside the repo                                                 | use pnpm; npm enforces `devEngines` and the system Node is older                                                                                                            |
| `Invalid configuration: - GRPC_PORT ...` at boot                                                   | env validation; see the service's `src/config.ts` and `.env.example`                                                                                                        |
| `/readyz` 503 with a service `UNREACHABLE`                                                         | that process is down or still starting: `pnpm exec pm2 logs <name> --lines 50`                                                                                              |
| service `NOT_SERVING`                                                                              | its `select 1` check fails: Postgres down or wrong `DATABASE_URL`                                                                                                           |
| `cannot create a test schema` in tests                                                             | run `pnpm db:setup` (creates `ga_test`)                                                                                                                                     |
| `EADDRINUSE`                                                                                       | another process holds the port: `lsof -nP -iTCP:<port> -sTCP:LISTEN`                                                                                                        |
| gateway: `TLS is enabled but ... cannot be read`; service: `GRPC_TLS_CERT_FILE=... cannot be read` | `pnpm certs`                                                                                                                                                                |
| `WORKLOAD_KEY_FILE=... cannot be read`, or `WORKLOAD_KEYS_FILE has no public key ...`              | `pnpm keys` (after `--rotate`, let it finish before restarting)                                                                                                             |
| browser warns about the certificate                                                                | install `mkcert` and run `pnpm certs --force` for a trusted cert                                                                                                            |
| 401 `AUTH_TOKEN_MISSING` / `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED`                             | no `authorization: Bearer` header, a token that is not from the dev IdP (issuer `http://127.0.0.1:8090`, audience `ga-api`), or an expired one: `pnpm dev:token` again      |
| 403 `USER_NOT_REGISTERED`                                                                          | the login has no user yet: `POST /v1/users` with that token                                                                                                                 |
| 403 `EMAIL_NOT_VERIFIED` on `POST /v1/users`                                                       | the token has no verified email: `pnpm dev:token <sub> --email <address>`                                                                                                   |
| 503 `IDENTITY_PROVIDER_UNAVAILABLE`                                                                | the gateway has no usable IdP keys: dev-idp is down (`pnpm exec pm2 logs dev-idp`)                                                                                          |
| a service answers `CALLER_*` / `PRINCIPAL_*` / `ACCESS_NOT_DECLARED` (500 at the gateway)          | a platform bug (missing `via` entry, wrong client `target`, an undeclared method) or a key mismatch (keys recreated while processes ran): `pnpm keys`, then `pnpm stack:up` |
| `refusing to serve plaintext gRPC on <host>`                                                       | `GRPC_HOST` is not loopback: set `GRPC_TLS_CERT_FILE` and `GRPC_TLS_KEY_FILE`                                                                                               |
| `refusing to call <target> over plaintext gRPC`                                                    | a non-loopback target needs `GRPC_TLS_CA_FILE`                                                                                                                              |
| `cannot verify TLS for 127.0.0.1:<port> ... IP address`                                            | with TLS, targets are host names: `*_SERVICE_URL=localhost:<port>`                                                                                                          |
| migration fails: `bookings has rows from before ADR-0004`                                          | dev data from before `host_id`: `pnpm db:setup --reset ga_booking --yes`, then `pnpm stack:up`                                                                              |
| `Nest can't resolve dependencies of X (?, ...)`                                                    | a constructor class was imported with `import type`, or a circular import; see `ga-architecture`                                                                            |
| `does not provide an export named ...` at startup                                                  | a type imported as a value; `pnpm build` runs `check-esm` to catch it                                                                                                       |
