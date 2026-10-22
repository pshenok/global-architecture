---

name: ga-architecture
description: Map and ground rules of the global-architecture platform (NestJS 12 gRPC microservices, HTTPS gateway, shared kernel/contracts/service-kit, Drizzle + Postgres, pnpm/Turborepo). Use this first whenever you work in this repository or on any service built from its template, even for a "small" change, and whenever you need to decide where code belongs, which package to import, which layer may depend on which, how errors/ids/pagination/logging work, or which other ga-* skill applies.
---

# global-architecture: platform map

A pnpm + Turborepo monorepo of Node 26 / NestJS 12 microservices. Domain services
talk gRPC to each other; one HTTPS gateway exposes REST to clients. Every service is
generated from one template and built on one shared chassis, so a fix or upgrade in
the chassis reaches every service.

## Repository layout

| Path                    | What                                                                                                                                     | Package                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `apps/<name>-service/`  | gRPC domain service, owns one Postgres database                                                                                          | `@ga/<name>-service`       |
| `apps/gateway/`         | HTTPS REST API (HTTP/2 + HTTP/1.1) -> gRPC                                                                                               | `@ga/gateway`              |
| `packages/kernel/`      | Framework-free domain primitives: errors, ports, Money, pagination                                                                       | `@ga/kernel`               |
| `packages/contracts/`   | All `.proto` contracts (one buf module), generated TS, proto runtime                                                                     | `@ga/contracts`            |
| `packages/service-kit/` | Chassis: config, logging, request context, gRPC server/clients, health, reflection, errors, DB, UoW, migrations, test helpers, telemetry | `@ga/service-kit`          |
| `templates/service/`    | The service template (`SampleItem` placeholder)                                                                                          | not a workspace package    |
| `tools/`                | Generator, template check, db setup, local stack, dev certs                                                                              | run with `node tools/x.ts` |
| `tests/e2e/`            | End-to-end suite against the running local stack                                                                                         |                            |
| `services.json`         | Registry: ports, databases, env var names of every service                                                                               | managed by the generator   |
| `docs/architecture/`    | Overview and ADRs (the "why")                                                                                                            |                            |

Existing services: `user-service` (50051), `house-service` (50052, calls user),
`booking-service` (50053, calls user + house), `gateway` (8443).

## Layers inside a service (dependency rule points inward)

```
transport/grpc  ->  application  ->  domain  <-  infrastructure
(controllers,       (use cases,      (aggregates,   (Drizzle repos,
 Zod requests,       ports of        invariants,     gRPC clients of
 mappers)            other systems)  repo ports,     other services)
                                     domain errors)
app.module.ts = composition root: binds every port to its adapter.
```

- `src/domain/` imports only `@ga/kernel` and other domain files. Biome enforces this
  (`noRestrictedImports` override in `biome.json`).
- `src/application/` may import domain, `@ga/kernel`, `@nestjs/common`; never Drizzle,
  gRPC, `@ga/contracts` or `@nestjs/microservices` (also enforced).
- Ports are **abstract classes**, not interfaces, so they double as Nest DI tokens:
  `constructor(private readonly users: UserRepository)` needs no `@Inject()`.
- Infrastructure and transport are adapters; only `app.module.ts` knows both sides.

Details and examples: the `ga-domain-logic` skill.

## Non-negotiable conventions (each one prevents a real bug)

- **ESM + `.ts` import specifiers** (`import { X } from './x.ts'`); SWC rewrites them to `.js`.
- **Injectable classes are value imports.** `import type { UserService }` compiles, but
  decorator metadata becomes `Object` and Nest DI breaks silently. Interfaces and type
  aliases must be `import type` (`verbatimModuleSyntax` enforces it). Biome's
  `useImportType` is deliberately off; do not turn it on.
- **Circular imports between injectables crash under ESM** even with `forwardRef`.
  Remove the cycle; if impossible, type the parameter as `Ref<T>` from `@ga/service-kit`.
- **Errors**: business failures throw a `DomainError` subclass from `@ga/kernel`
  (`ValidationError`, `NotFoundError`, `ConflictError`, `PreconditionFailedError`,
  `ConcurrencyError`, `DependencyUnavailableError`, ...) with an UPPER_SNAKE `reason`.
  The kit maps it to a gRPC status with `google.rpc.ErrorInfo`; the gateway maps that
  to HTTP + RFC 9457 problem+json. Never throw HTTP or gRPC exceptions from domain or
  application code. Unexpected errors become `INTERNAL "Internal error"`; messages never leak.
- **Ids** are UUIDv7 from the injected `IdGenerator`; **time** comes from the injected `Clock`.
- **Pagination** is keyset (`id < cursor ORDER BY id DESC`) with opaque `page_token`s bound
  to the filter (`filterFingerprint`, `encodePageToken`, `decodePageToken`,
  `resolvePageSize`, `toPage` in `@ga/kernel`).
- **Money** is integer minor units (`Money` in `@ga/kernel`), never floats.
- **Database per service.** No service reads another service's tables, and there are no
  cross-service foreign keys. Other services' data comes through their gRPC API.
- **Invariants that involve concurrency live in Postgres** (unique, check, exclusion
  constraints) and are translated with `translateDbError`; check-then-insert is a race.
- **Config** is a Zod schema in `src/config.ts`, validated at boot; add every new variable
  there and to `.env.example`.
- **Logging**: `new Logger(MyClass.name)` from `@nestjs/common` (routed to pino with the
  request id). One automatic line per RPC already exists; do not log payloads or PII.

## Where does it go?

| You need to...                                      | Put it in                                                          | Skill                      |
| --------------------------------------------------- | ------------------------------------------------------------------ | -------------------------- |
| A new microservice                                  | `pnpm new:service <noun>`                                          | `ga-new-service`           |
| A new RPC / field / enum                            | `packages/contracts/proto/ga/<domain>/v1/*.proto`                  | `ga-grpc-contracts`        |
| A business rule                                     | domain aggregate or use case                                       | `ga-domain-logic`          |
| A table / column / constraint / migration           | `src/infrastructure/persistence/schema.ts` + `drizzle/`            | `ga-database`              |
| Data from another service                           | a port in `application/ports`, adapter in `infrastructure/clients` | `ga-service-communication` |
| A public REST endpoint                              | `apps/gateway/src/<resource>/`                                     | `ga-gateway-endpoint`      |
| Tests                                               | `*.spec.ts` next to code, `test/*.spec.ts` for gRPC + Postgres     | `ga-testing`               |
| Run / debug everything locally                      | `pnpm stack:up`                                                    | `ga-local-stack`           |
| Review a change                                     |                                                                    | `ga-code-review`           |
| Change the chassis, template or dependency versions | `packages/*`, `templates/service`, `pnpm-workspace.yaml`           | `ga-platform-maintenance`  |

## Everyday commands (repo root)

```bash
pnpm install                 # Node 26 and pnpm 12 are downloaded automatically (devEngines)
pnpm check                   # biome + oxlint + typecheck + tests
pnpm build                   # SWC build of everything (turbo-cached)
pnpm --filter @ga/user-service test
pnpm stack:up                # whole system on PM2: https://localhost:8443/docs
```

## Known gaps (do not paper over them)

- **No authentication or authorization yet.** Every endpoint is open; processes bind
  to 127.0.0.1 locally. Do not expose the gateway publicly. The planned design is in
  `docs/architecture/adr/0004-identity-and-authorization.md`.
- **No asynchronous messaging yet.** Cross-service consistency on delete (e.g. bookings
  of a deleted house) is not handled; the planned outbox + broker design is in
  `docs/architecture/adr/0005-asynchronous-events.md`.
- **No idempotency keys** on create RPCs yet (AIP-155 `request_id` is the planned shape).
