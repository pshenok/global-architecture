---

name: ga-architecture
description: Map and ground rules of the global-architecture platform (NestJS 12 gRPC microservices, HTTPS gateway, shared kernel/contracts/service-kit, Drizzle + Postgres, pnpm/Turborepo, OIDC at the gateway and signed identity between services, asynchronous events through event-bus-service). Use this first whenever you work in this repository or on any service built from its template, even for a "small" change, and whenever you need to decide where code belongs, which package to import, which layer may depend on which, how errors/ids/pagination/logging/identity and access work, or which other ga-* skill applies.
---

# global-architecture: platform map

A pnpm + Turborepo monorepo of Node 26 / NestJS 12 microservices. Domain services
talk gRPC to each other; one HTTPS gateway exposes REST to clients. Every service is
generated from one template and built on one shared chassis, so a fix or upgrade in
the chassis reaches every service.

## Repository layout

| Path                      | What                                                                                                                                                                                                                                          | Package                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/<name>-service/`    | gRPC domain service, owns one Postgres database                                                                                                                                                                                               | `@ga/<name>-service`                                 |
| `apps/event-bus-service/` | The platform's pub/sub service (ADR-0005): event catalog, `EventBroker` and `EventBrokerAdmin` ports, Postgres backend, `events:*` CLI                                                                                                        | `@ga/event-bus-service`                              |
| `apps/gateway/`           | HTTPS REST API (HTTP/2 + HTTP/1.1) -> gRPC; authenticates every request                                                                                                                                                                       | `@ga/gateway`                                        |
| `packages/kernel/`        | Framework-free domain primitives: errors, actors, ports, Money, pagination                                                                                                                                                                    | `@ga/kernel`                                         |
| `packages/contracts/`     | All `.proto` contracts (one buf module), generated TS, proto runtime                                                                                                                                                                          | `@ga/contracts`                                      |
| `packages/service-kit/`   | Chassis: config, logging, request context, auth (workload identity, `@Access` guard), gRPC server/clients with TLS, health, reflection, errors, DB, UoW, migrations, events (`src/events/`: outbox, relay, consumer), test helpers, telemetry | `@ga/service-kit`                                    |
| `templates/service/`      | The service template (`SampleItem` placeholder, owned by the user who creates it)                                                                                                                                                             | not a workspace package                              |
| `tools/`                  | Generator, template check, db setup, local stack, dev certs and keys, dev IdP, `grpc:call`, access check, call-graph check                                                                                                                    | run through the root `pnpm` scripts (pinned Node 26) |
| `tests/e2e/`              | End-to-end suite against the running local stack                                                                                                                                                                                              |                                                      |
| `security/`               | `public-endpoints.json`: every endpoint reachable without a signed-in user, with its reason                                                                                                                                                   | checked by `pnpm lint`; CODEOWNERS                   |
| `services.json`           | Registry: ports, databases, env var names of every service                                                                                                                                                                                    | managed by the generator                             |
| `docs/architecture/`      | Overview and ADRs (the "why")                                                                                                                                                                                                                 |                                                      |

The current services, their ports, databases and env var names are in `services.json`;
the dependency graph is in `docs/architecture/overview.md`. The gateway listens on 8443.

## Layers inside a service (dependency rule points inward)

```
transport/grpc  ->  application  ->  domain  <-  infrastructure
transport/events    (use cases,      (aggregates,   (Drizzle repos,
(controllers,        ports of        invariants,     gRPC clients of
 @OnEvent handlers,  other systems)  repo ports,     other services,
 Zod requests,                       domain errors)  outbox adapters)
 mappers)
app.module.ts = composition root: binds every port to its adapter.
```

- `src/domain/` imports only `@ga/kernel` and other domain files.
- `src/application/` may import domain, `@ga/kernel`, `@nestjs/common`; never Drizzle,
  gRPC, `@ga/contracts`, `@nestjs/microservices`, infrastructure or transport.
- Biome's `noRestrictedImports` overrides (`biome.json`) block the framework/persistence
  packages and relative imports of the wrong layers (`**/infrastructure/**`, ...). Lint
  cannot see everything (an unexpected npm package in the domain, a cross-layer import
  through a re-export), so reviewers still check the direction of dependencies.
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
- **No circular imports.** Between injectables they crash under ESM even with
  `forwardRef`, and Biome's `noImportCycles` fails the build. Break a cycle by extracting
  the shared part into a third provider or a port. (`Ref<T>` in `@ga/service-kit` exists
  for code outside this repo's lint rules; it only works with `@Inject(forwardRef(() => B))`.)
- **Errors**: business failures throw a `DomainError` subclass from `@ga/kernel`
  (`ValidationError`, `NotFoundError`, `ConflictError`, `PreconditionFailedError`,
  `PermissionDeniedError`, `ConcurrencyError`, `DependencyUnavailableError`, ...) with an
  UPPER_SNAKE `reason`. The kit maps it to a gRPC status with `google.rpc.ErrorInfo`; the
  gateway maps that to HTTP + RFC 9457 problem+json. Never throw HTTP or gRPC exceptions
  from domain or application code. Unexpected errors become `INTERNAL "Internal error"`;
  messages never leak.
- **Ids** are UUIDv7 from the injected `IdGenerator`; **time** comes from the injected `Clock`.
- **Pagination** is keyset (`id < cursor ORDER BY id DESC`) with opaque `page_token`s bound
  to the filter, and for private data to the caller and its scope (`filterFingerprint`,
  `encodePageToken`, `decodePageToken`, `resolvePageSize`, `toPage` in `@ga/kernel`).
- **Money** is integer minor units (`Money` in `@ga/kernel`), never floats.
- **Database per service.** No service reads another service's tables, and there are no
  cross-service foreign keys. Other services' data comes through their gRPC API.
- **Calls form a DAG; reactions are events** (ADR-0005). Synchronous calls never close a
  cycle and never run inside a transaction (the kit refuses them). When a service must
  react to what happened in another (a delete), the producer records an event with
  `Outbox.add` in the change's transaction and consumers handle it with `@OnEvent`,
  through `event-bus-service`, which calls nobody. `tools/check-call-graph.ts` (in
  `pnpm lint`) enforces the DAG and that the bus calls nobody; at run time every service
  also refuses a call the bus signed.
- **Invariants that involve concurrency live in Postgres** (unique, check, exclusion
  constraints) and are translated with `translateDbError`; check-then-insert is a race.
- **Config** is a Zod schema in `src/config.ts`, validated at boot; add every new variable
  there and to `.env.example`.
- **Logging**: `new Logger(MyClass.name)` from `@nestjs/common` (routed to pino with the
  request id). One automatic line per RPC already exists (with the calling workload and
  user id); do not log payloads, PII or tokens.

## Identity and access (ADR-0004)

- **Authentication happens once, at the gateway.** It verifies OIDC access tokens of the
  providers in `AUTH_ISSUERS`, maps the login to its platform user (user-service
  `ResolveIdentity`, cached) and signs a short-lived principal for the request. Roles
  (`admin`) are platform data in user-service, never IdP claims.
- **Every internal call carries two signed tokens** in gRPC metadata: `x-ga-caller`
  (signed by the calling workload for this callee, per hop) and `x-ga-principal` (the
  end user, signed by the gateway, forwarded unchanged). The service kit sets and
  verifies both; application code never builds them.
- **Every RPC declares `@Access`** (`user`, `admin`, `identity`, `service`,
  `public(reason)`). A service with an undeclared method does not start, and there is no
  switch that turns the guard off.
- **Use cases take the actor first.** Controllers pass `currentUser()`; ownership and
  visibility rules live in the domain. A caller that may not know a resource exists gets
  `NOT_FOUND`; a visible resource with a forbidden action gets `PERMISSION_DENIED`. Lists
  take a typed scope.
- **gRPC uses TLS off loopback.** A service refuses to bind a non-loopback address without
  a certificate, and a client refuses a non-loopback target without `GRPC_TLS_CA_FILE`.
  The local stack runs TLS on every hop.
- **Public is a reviewed decision.** Every endpoint reachable without a signed-in user is
  listed with its reason in `security/public-endpoints.json`; `pnpm lint` compares the
  list with the source and the tests with the metadata the apps really carry, and
  CODEOWNERS protects it.

Details: `ga-domain-logic` (rules), `ga-service-communication` (forwarding, `via`),
`ga-gateway-endpoint` (routes), `ga-testing` (access tests), `ga-local-stack` (tokens).

## Where does it go?

| You need to...                                            | Put it in                                                                                                                                    | Skill                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| A new microservice                                        | `pnpm new:service <noun>`                                                                                                                    | `ga-new-service`           |
| A new RPC / field / enum                                  | `packages/contracts/proto/ga/<domain>/v1/*.proto`                                                                                            | `ga-grpc-contracts`        |
| A business rule                                           | domain aggregate or use case                                                                                                                 | `ga-domain-logic`          |
| Who may call an RPC, see or change a resource             | `@Access` on the controller method; ownership, visibility and list scope in the domain                                                       | `ga-domain-logic`          |
| A table / column / constraint / migration                 | `src/infrastructure/persistence/schema.ts` + `drizzle/`                                                                                      | `ga-database`              |
| Data from another service                                 | a port in `application/ports`, adapter in `infrastructure/clients`                                                                           | `ga-service-communication` |
| Tell other services something happened (an event)         | a port in `application/ports`, outbox adapter in `infrastructure/events`                                                                     | `ga-service-communication` |
| React to another service's event                          | an `@OnEvent` handler in `src/transport/events`                                                                                              | `ga-service-communication` |
| A new event payload                                       | `ga/<domain>/v1/<domain>_events.proto`                                                                                                       | `ga-grpc-contracts`        |
| Register an event type, producer or subscriber            | `apps/event-bus-service/src/domain/topics.ts` (+ the bus's `@Access.service` lists and `security/public-endpoints.json` if a workload joins) | `ga-service-communication` |
| A public REST endpoint                                    | `apps/gateway/src/<resource>/`                                                                                                               | `ga-gateway-endpoint`      |
| Tests                                                     | `*.spec.ts` next to code, `test/*.spec.ts` for gRPC + Postgres                                                                               | `ga-testing`               |
| Run / debug everything locally                            | `pnpm stack:up`                                                                                                                              | `ga-local-stack`           |
| Review a change                                           |                                                                                                                                              | `ga-code-review`           |
| Change the chassis, template, dependency versions or keys | `packages/*`, `templates/service`, `pnpm-workspace.yaml`                                                                                     | `ga-platform-maintenance`  |

## Everyday commands (repo root)

```bash
pnpm install                 # Node 26 and pnpm 12 are downloaded automatically (devEngines)
pnpm check                   # biome + check-access + check-call-graph + oxlint + typecheck + tests
pnpm build                   # SWC build of everything (turbo-cached)
pnpm --filter @ga/user-service test
pnpm stack:up                # whole system on PM2: https://localhost:8443/docs
                             # (certs, keys, dev IdP, .env files, databases, migrations; checks every service)
pnpm dev:token alice --email alice@example.com   # access token from the local dev IdP
```

## Known gaps (do not paper over them)

- **Late writes after a delete can stay orphaned.** Creating a house or a booking checks
  that its owner, guest or house exists, then inserts without a lock; one created between
  that check and the delete's cleanup event is not cleaned up (ADR-0005). Tombstones
  checked on create are the follow-up if it matters.
- **No idempotency keys** on create RPCs yet (AIP-155 `request_id` is the planned shape).
