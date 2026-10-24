---

name: ga-local-stack
description: Run, observe and debug the whole global-architecture system locally - pnpm stack:up/down with PM2 and local Postgres, db:setup (and --reset) and migrations, dev TLS certificates and the gRPC CA, workload keys and their rotation, the local dev IdP and access tokens (pnpm dev:token), registering and granting admin, calling RPCs with pnpm grpc:call and buf curl over TLS, watch mode, logs with request ids, health checks, event-bus-service and pnpm events:status/redrive/replay/drop (event lag, dead letters, backfills, retired types), OpenTelemetry tracing, Docker images, and troubleshooting (ports, pnpm release-age gate, PM2, Postgres roles, 401/403/503 auth errors, CALLER_*/PRINCIPAL_* rejections, TLS and key errors, events that do not arrive). Use it whenever someone wants to start, restart, inspect or debug services locally, get a token, reproduce a bug across services, read logs, call a gRPC method by hand, see why an event or a cleanup did not happen, or when something fails to boot.
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
an Ed25519 key per workload plus the public key map (`pnpm keys`). PM2 runs every service
(`event-bus-service` on 50050 included), the gateway and `dev-idp`, a local OIDC provider on `http://127.0.0.1:8090`
(`services.json` `devIdp.port`) that signs any subject it is asked for; it listens on
loopback only and refuses `NODE_ENV=production`. The command waits until every service is
SERVING and the gateway's `/readyz` is 200 with `status: "ok"` (it reaches every service
itself) and `identityProvider: "ok"` (its IdP keys are loaded), then prints the URLs: API `https://localhost:8443/v1/...`, docs
`https://localhost:8443/docs`, each service's `grpcs://localhost:<port>`. Everything binds
to 127.0.0.1, and gRPC runs TLS on every hop.

Prerequisite: Postgres 16+ on `localhost:5432` with a superuser login (`PG_ADMIN_URL`,
default `postgresql://$USER@localhost:5432/postgres`). `pnpm db:setup` creates missing
`apps/*/.env` files from `.env.example`, the `ga` role (password `ga`), one database per
service from `services.json`, `ga_test`, and any declared extensions. The stack, the
migrations and the tests always connect as `ga:ga@localhost:5432`, so a Postgres
elsewhere (another host or port, Docker on 5433) needs a port forward to
`localhost:5432`; changing `PG_ADMIN_URL` alone splits the setup across two servers.
`pnpm db:setup --reset ga_booking --yes` drops and recreates the named databases (dev data
only), then run `pnpm stack:up` to migrate them. It refuses production and a Postgres
that is not local (loopback or a Unix socket), and drops only databases `db:setup`
created: they carry a comment marker. Databases from an older `db:setup` (before the
marker) need `--adopt` once: `pnpm db:setup --reset ga_booking --yes --adopt`. A database
created any other way is never dropped. The marker cannot tell a shared server behind a
localhost port forward from your own, so never run `--reset` through one.

## Signing in

Every API route except the health probes, the house catalogue and registration needs a
registered user (`/docs` and `/openapi.json` are open).

```bash
TOKEN=$(pnpm -s dev:token alice --email alice@example.com)   # 900 s; --ttl <s>, --unverified
curl -s --cacert .certs/dev-cert.pem -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"fullName":"Alice"}' https://localhost:8443/v1/users
curl -s --cacert .certs/dev-cert.pem -H "authorization: Bearer $TOKEN" https://localhost:8443/v1/users/me
pnpm users:grant-role <userId> admin    # roles live in user-service, never in the IdP; --by <name> to record who
pnpm users:revoke-role <userId> admin   # takes effect within the gateway's 60 s identity cache
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

## Events (ADR-0005)

`event-bus-service` (`grpcs://localhost:50050`, database `ga_event_bus`) is a service like
the others: PM2 starts it and injects `EVENT_BUS_SERVICE_URL` into every process. Each
producer's relay publishes its `outbox` rows within about half a second
(`EVENTS_POLL_MS`, default 500), and each consumer pulls at the same pace, so a cleanup
reaches the next service in about a second and user -> house -> booking in two to three.

```bash
pnpm events:status                                                     # pending, dead, oldest pending age per subscriber and type
pnpm events:redrive --subscriber booking-service [--type ga.house.v1.HouseDeletedEvent]   # dead letters back to pending, fresh attempts
pnpm events:replay --subscriber house-service --type ga.user.v1.UserDeletedEvent --since 2026-10-01T00:00:00Z   # backfill retained events
pnpm events:drop --subscriber <workload> --type <fqn>                  # delete the rows of a pair the catalog no longer lists
```

They run against the bus's own database (`apps/event-bus-service/.env`), print one line
per change (keep it, it is the only record), and check the catalog of the build they run
from: `replay` and `redrive --type` refuse a pair it does not list (`redrive` without
`--type` skips and counts those rows), `drop` refuses a pair it lists. Retention keeps
delivered events for `EVENT_BUS_RETENTION_DAYS` (7, at most 21: consumers remember
processed event ids for 30 days); dead letters keep their event until redriven, so
`replay` queues only events from the last 21 days and skips (and counts) older ones.
- **Lag** shows in `events:status` (bus side) and in the producer's `outbox` table: a row
  that stays has `last_error` and a future `available_at` (`ga-database` has the query).
- **Dead letters**: a delivery is dead after `EVENT_BUS_MAX_ATTEMPTS` (10) leases, or at
  once for a deterministic failure; the consumer logs `dead-lettered <type> <id>: <reason>`.
  Fix the cause, then `events:redrive`. A failed handler rolled back, so that dead letter
  runs once. A `LEASE_EXPIRED` one may have been applied: the consumer acks a batch only
  at its end, so the batch-mates of a delivery that crashes the process commit but are
  never acked. The consumer's `processed_events` skips them on redrive only while it
  remembers their ids (30 days).
- **Orphaned rows**: `events:status` marks `orphaned` the deliveries of a pair the catalog
  no longer lists (a retired type, a subscriber moved to a v2 type or removed from a
  topic). Nothing leases or redrives them (the subscriber's next pull still turns one
  whose last lease ran out into a dead letter), and they keep their events from
  retention: `pnpm events:drop --subscriber <name> --type <fqn>` deletes them.
- **Shutdown**: relay and consumer stop claiming and wait for the in-flight round at most
  `EVENTS_DRAIN_MS` (5000). Keep `EVENTS_DRAIN_MS` + `SHUTDOWN_DELAY_MS` below PM2's
  `kill_timeout` (15000), or the process is killed mid-publish (harmless: the row is
  published again, the delivery redelivered).
- A service run outside PM2 (`pnpm --filter ... dev`) reads its own `.env`: files created
  before events existed need `EVENT_BUS_SERVICE_URL=localhost:50050` added by hand
  (`db:setup` creates only missing `.env` files).
- Asynchronous parts register no health checks: a bus outage leaves every API SERVING and
  only grows outbox rows and consumer lag.

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
pnpm certs [--force]                     # HTTPS certificate, gRPC CA + server certificate (renewed 30 days before expiry)
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
| `/readyz` `degraded` with a service `UNREACHABLE`                                                  | that process is down or still starting: `pnpm exec pm2 logs <name> --lines 50`                                                                                              |
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
| migration fails: `bookings has rows from before ADR-0004`                                          | dev data from before `host_id`: `pnpm db:setup --reset ga_booking --yes --adopt` (`--adopt`: that database predates the reset marker), then `pnpm stack:up`                 |
| `Nest can't resolve dependencies of X (?, ...)`                                                    | a constructor class was imported with `import type`, or a circular import; see `ga-architecture`                                                                            |
| `does not provide an export named ...` at startup                                                  | a type imported as a value; `pnpm build` runs `check-esm` to catch it                                                                                                       |
| `EventsModule: table outbox is missing or differs` (or `processed_events`) at boot                 | migrations not applied (`pnpm stack:up`), or the table copy in `schema.ts` drifted from `ga-database`                                                                       |
| `EventsModule: the service config lacks the events variables`                                      | spread `...eventsConfigSchema.shape` into the service's `ConfigSchema`                                                                                                      |
| `Invalid configuration: - EVENT_BUS_SERVICE_URL ...` with `pnpm dev`                               | its `.env` predates events: add `EVENT_BUS_SERVICE_URL=localhost:50050`                                                                                                     |
| a cleanup never happens; producer logs `event ... not published ...: REJECTED EVENT_TYPE_UNKNOWN`  | the bus catalog lacks the type (or the bus runs an old build): add it to `topics.ts`, rebuild and restart `event-bus-service`; the row goes out on its own                  |
| `pnpm events:status` shows dead deliveries                                                         | read the consumer's `dead-lettered ...` line, fix the cause, then `pnpm events:redrive --subscriber <name>`                                                                 |
| `pnpm events:status` shows `orphaned` rows, or `events:redrive` reports skipped ones               | the catalog no longer lists that pair: restore the entry if it should, else `pnpm events:drop --subscriber <name> --type <fqn>` (retention then purges the events)          |
| `Invalid configuration: - EVENT_BUS_RETENTION_DAYS ...`                                            | at most 21: consumers forget processed event ids after 30 days, so `events:replay` never queues older events                                                                |
