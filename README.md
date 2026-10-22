# global-architecture

A production-shaped template for building a system of many Node.js microservices:
NestJS 12 gRPC services with clean architecture and their own Postgres databases, one
HTTPS REST gateway, a shared chassis, a service generator, and Claude Code skills that
encode the rules.

It replaces the `nest-clean-grpc` boilerplate (its audit: `docs/audit/nest-clean-grpc-audit.md`).

```
            HTTPS (HTTP/2 + HTTP/1.1), REST, problem+json
client ───────────────────────────────▶ gateway :8443
                                          │ gRPC (deadlines, retries, x-request-id)
              ┌───────────────────────────┼──────────────────────────┐
              ▼                           ▼                          ▼
      user-service :50051       house-service :50052       booking-service :50053
              │                    │  └──▶ user-service        │  ├──▶ user-service
              ▼                    ▼                           ▼  └──▶ house-service
          ga_user (pg)         ga_house (pg)               ga_booking (pg)
```

## Quick start

Prerequisites: a reachable Postgres 16+ with a superuser login (default
`postgresql://$USER@localhost:5432/postgres`, override with `PG_ADMIN_URL`) and any
`pnpm` 10+ (the repo pins and downloads Node 26 and pnpm 12 itself).

```bash
pnpm install
pnpm stack:up        # build, TLS cert, databases, migrations, start on PM2, wait for readiness
pnpm test:e2e        # end-to-end checks over HTTPS
open https://localhost:8443/docs
pnpm stack:down
```

```bash
curl -s --cacert .certs/dev-cert.pem https://localhost:8443/v1/users \
  -H 'content-type: application/json' -d '{"email":"ann@example.com","fullName":"Ann"}'
```

## What is inside

| Path                                                              |                                                                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/user-service`, `apps/house-service`, `apps/booking-service` | example domain services (users, listings, reservations)                                                          |
| `apps/gateway`                                                    | public REST API -> gRPC, OpenAPI at `/openapi.json`, docs at `/docs`                                             |
| `packages/kernel`                                                 | domain primitives: errors, ports, money, pagination                                                              |
| `packages/contracts`                                              | all `.proto` contracts (buf), generated TypeScript, proto runtime                                                |
| `packages/service-kit`                                            | chassis: config, logging, gRPC server/clients, health, reflection, errors, DB, migrations, test helpers, tracing |
| `templates/service`                                               | the service template used by `pnpm new:service`                                                                  |
| `plugins/ga-platform`                                             | Claude Code plugin with the platform skills (also linked into `.claude/skills`)                                  |
| `docs/architecture`                                               | overview and architecture decision records                                                                       |
| `tools`, `tests/e2e`                                              | generator, template check, db setup, local stack, end-to-end suite                                               |

## Stack

Node 26, pnpm 12 + Turborepo, TypeScript 7 (type checking) + SWC (emit), NestJS 12,
gRPC (`@grpc/grpc-js`, buf, ts-proto), Fastify 5 (gateway), Zod 4, Drizzle ORM 1.0 +
node-postgres, pino, OpenTelemetry, Vitest 5, Biome + oxlint, PM2 for the local stack.
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
```

## Working with Claude Code

Open the repo in Claude Code: `CLAUDE.md` and the `ga-*` skills load automatically.
Start from the `ga-architecture` skill. To use the skills in another repository:

```text
/plugin marketplace add pshenok/global-architecture
/plugin install ga-platform@global-architecture
```

## Status and known gaps

Verified locally: every package's tests, the template check, the PM2 stack and the
end-to-end suite. Not built yet, by design of this first iteration:
- authentication and authorization (proposal: ADR-0004), so do not expose the gateway;
- asynchronous events / outbox (proposal: ADR-0005);
- idempotency keys for create RPCs;
- CI pipeline, container publishing and infrastructure (Dockerfiles exist but were not
  built here).
