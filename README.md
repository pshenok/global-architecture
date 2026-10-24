# global-architecture

A production-shaped template for building a system of many Node.js microservices:
NestJS 12 gRPC services with clean architecture and their own Postgres databases, one
HTTPS REST gateway, a shared chassis, a service generator, and Claude Code skills that
encode the rules.

It replaces the `nest-clean-grpc` boilerplate (its audit: `docs/audit/nest-clean-grpc-audit.md`).

```
 OIDC provider (locally: dev-idp :8090)
        │ access token
        ▼    HTTPS (HTTP/2 + HTTP/1.1), REST + Bearer token, problem+json
client ───────────────────────────────▶ gateway :8443  (verifies the token, maps it to a user)
                                          │ gRPC over TLS: signed caller + principal per hop,
                                          │ deadlines, retries, x-request-id
              ┌───────────────────────────┼──────────────────────────┐
              ▼                           ▼                          ▼
      user-service :50051       house-service :50052       booking-service :50053
              │                    │  └──▶ user-service        │  ├──▶ user-service
              ▼                    ▼                           ▼  └──▶ house-service
          ga_user (pg)         ga_house (pg)               ga_booking (pg)
              ┊ publish            ┊ publish + pull             ┊ pull
              └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┼┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘
                                   ▼
                       event-bus-service :50050  (calls nobody)
                                   ▼
                            ga_event_bus (pg)
```

Deleting a user removes its houses and cancels its stays; deleting a house cancels its
stays. Both happen asynchronously, through events (ADR-0005).

## Quick start

Prerequisites: Postgres 16+ listening on `localhost:5432` with a superuser login
(default `postgresql://$USER@localhost:5432/postgres`; `PG_ADMIN_URL` changes only the
login `pnpm db:setup` uses, while services, migrations and tests connect as
`ga:ga@localhost:5432`), and any `pnpm` 10+ (the repo pins and downloads Node 26 and
pnpm 12 itself).

```bash
pnpm install
pnpm stack:up        # build, .env files, TLS certs, workload keys, databases, migrations, PM2 (incl. dev IdP), wait until ready
pnpm test:e2e        # end-to-end checks over HTTPS
open https://localhost:8443/docs
pnpm stack:down
```

```bash
TOKEN=$(pnpm -s dev:token ann --email ann@example.com)   # a login at the local dev IdP
curl -s --cacert .certs/dev-cert.pem https://localhost:8443/v1/users \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"fullName":"Ann"}'
curl -s --cacert .certs/dev-cert.pem https://localhost:8443/v1/users/me -H "authorization: Bearer $TOKEN"
```

Every route except the health probes and the house catalogue needs a token, and every
login registers once (`POST /v1/users`). See ADR-0004 for who may do what.

## What is inside

| Path                                                              |                                                                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apps/user-service`, `apps/house-service`, `apps/booking-service` | example domain services (users, listings, reservations)                                                                             |
| `apps/event-bus-service`                                          | the platform's publish/subscribe service; the queue plugs in behind its `EventBroker` and `EventBrokerAdmin` ports (Postgres today) |
| `apps/gateway`                                                    | public REST API -> gRPC, OpenAPI at `/openapi.json`, docs at `/docs`                                                                |
| `packages/kernel`                                                 | domain primitives: errors, actors, ports, money, pagination                                                                         |
| `packages/contracts`                                              | all `.proto` contracts (buf), generated TypeScript, proto runtime                                                                   |
| `packages/service-kit`                                            | chassis: config, logging, gRPC server/clients + TLS, workload identity and access checks, health, errors, DB, test helpers, tracing |
| `templates/service`                                               | the service template used by `pnpm new:service`                                                                                     |
| `plugins/ga-platform`                                             | Claude Code plugin with the platform skills (also linked into `.claude/skills`)                                                     |
| `docs/architecture`                                               | overview and architecture decision records                                                                                          |
| `security/`                                                       | allowlist of endpoints reachable without a signed-in user (checked by `pnpm lint`)                                                  |
| `tools`, `tests/e2e`                                              | generator, template check, db setup, local stack, dev IdP, keys, end-to-end suite                                                   |

## Stack

Node 26, pnpm 12 + Turborepo, TypeScript 7 (type checking) + SWC (emit), NestJS 12,
gRPC (`@grpc/grpc-js`, buf, ts-proto), Fastify 5 (gateway), Zod 4, Drizzle ORM 1.0 RC
(exact pin) + node-postgres, jose (OIDC and workload tokens), pino, OpenTelemetry, Vitest 5,
Biome + oxlint, PM2 for the local stack.
Why each was chosen: `docs/architecture/adr/0001-platform-stack.md`.

## Everyday commands

```bash
pnpm check                         # lint + typecheck + tests (all packages)
pnpm build
pnpm new:service review            # scaffold a new service from the template
pnpm template:verify               # prove the template still generates a green service
pnpm --filter @ga/contracts codegen
pnpm --filter @ga/booking-service test
pnpm stack:status | pnpm stack:logs
pnpm dev:token <sub> --email <email>                       # token from the local dev IdP
pnpm grpc:call <service> <Method> '<json>' --as <userId>   # call a service as the platform does
pnpm users:grant-role <userId> admin                       # platform roles (users:revoke-role to remove)
pnpm events:status                                         # event lag and dead letters (events:redrive, events:replay, events:drop)
pnpm keys [--rotate|--prune <workload>]                    # local workload keys
```

## Working with Claude Code

Open the repo in Claude Code: `CLAUDE.md` and the `ga-*` skills load automatically.
Start from the `ga-architecture` skill. To use the skills in another repository (you need
read access to this GitHub repository):

```text
/plugin marketplace add pshenok/global-architecture
/plugin install ga-platform@global-architecture
```

## Status and known gaps

Verified: every package's tests, the template check, the PM2 stack with the end-to-end
suite, a fresh-clone start, and the user-service container image (distroless, non-root).
CI (`.github/workflows/ci.yml`) runs the same gate on every push and PR. Not built yet,
by design of this first iteration:
- tombstones against late writes: a house or booking created while its user or house is
  being deleted can stay orphaned (ADR-0005);
- idempotency keys for create RPCs;
- image publishing and deployment infrastructure.
