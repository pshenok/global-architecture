# Architecture overview

## Goals

1. Hundreds of services that all look the same inside, so any engineer (or AI agent)
   can work on any of them.
2. Correctness by construction: invariants in the database, typed contracts, one error
   model, no silent fallbacks.
3. A shared chassis instead of copy-paste, with a template that is continuously verified.
4. Fast local feedback: the whole system runs on a laptop without containers.

## Containers

```mermaid
flowchart LR
  idp([OIDC provider\nlocally: dev-idp]) -. "access token" .-> client([Client / frontend])
  client -- "HTTPS REST + Bearer token\nproblem+json" --> gw[gateway\nNestJS + Fastify]
  gw -. "JWKS (background)" .-> idp
  gw -- "gRPC/TLS: ResolveIdentity" --> us[user-service]
  gw -- "gRPC/TLS" --> hs[house-service]
  gw -- "gRPC/TLS" --> bs[booking-service]
  hs -- "gRPC/TLS: owner's account exists?" --> us
  bs -- "gRPC/TLS: guest's account exists?" --> us
  bs -- "gRPC/TLS: house terms + owner" --> hs
  us -. "Publish (outbox relay)" .-> eb[event-bus-service]
  hs -. "Publish (outbox relay)" .-> eb
  hs -. "Pull / Ack" .-> eb
  bs -. "Pull / Ack" .-> eb
  us --- udb[(ga_user)]
  hs --- hdb[(ga_house)]
  bs --- bdb[(ga_booking)]
  eb --- edb[(ga_event_bus)]
```

Every gRPC call carries two signed tokens (ADR-0004): `x-ga-caller`, signed by the
calling workload for this callee, and `x-ga-principal`, the end user as the gateway
verified it. Services check both against `@Access` on each method.
- **Gateway**: the only public entrypoint; owns the REST contract, validation, OpenAPI,
  error presentation, rate limits and security headers. No business logic, no database.
- **Domain services**: own one capability and one database each; expose gRPC only;
  health via `grpc.health.v1`; server reflection on.
- **Dependencies form a DAG** (booking -> house -> user). Back-references are events
  through event-bus-service, which calls nobody (`tools/check-call-graph.ts` enforces
  both in `pnpm lint`).
- **Event bus** (ADR-0005): producers record events in their own `outbox` table in the
  transaction of the change; the kit's relay publishes them; consumers pull, apply each
  event once (`processed_events`) and ack. The queue behind the bus sits behind its
  private `EventBroker` and `EventBrokerAdmin` ports (Postgres adapters today).

## Inside a service

```mermaid
flowchart TB
  subgraph transport [transport/grpc]
    ctl[Controller\nZod request validation\nmappers]
  end
  subgraph events [transport/events]
    con["@OnEvent consumers\ncurrentService() to one use case"]
  end
  subgraph application [application]
    uc[Use cases]
    ports[Ports to other systems\nand event ports]
  end
  subgraph domain [domain]
    agg[Aggregates + invariants]
    repo[Repository ports]
    err[Domain errors]
  end
  subgraph infrastructure [infrastructure]
    drz[Drizzle repositories]
    cli[gRPC client adapters]
    obx[Outbox event adapters\nOutbox.add in the transaction]
  end
  ctl --> uc --> agg
  con --> uc
  uc --> repo
  uc --> ports
  drz -. implements .-> repo
  cli -. implements .-> ports
  obx -. implements .-> ports
```

The composition root (`app.module.ts`) binds ports to adapters. Biome blocks framework
and persistence packages and relative imports of the wrong layers in `src/domain` and
`src/application`; review covers what lint cannot see.

## Request lifecycle (create a booking)

1. Gateway (Fastify, HTTP/2 + TLS) assigns or accepts `x-request-id` and rate-limits.
   `AuthGuard` verifies the bearer token against the provider's cached keys, maps the
   login to its user (`ResolveIdentity`, cached) and signs a principal for this request.
   The body is validated with Zod; the gateway calls `BookingService.CreateBooking` with
   a 5 s deadline, a caller assertion for booking-service and the principal.
2. booking-service's `GrpcAuthGuard` checks the caller (the gateway) and the principal
   against `@Access.user()`. The request is validated (Zod) and the use case gets the
   user as its first argument: the guest is the caller, never a request field. It
   validates the stay locally, then asks user-service and house-service in parallel
   (2 s deadlines; each call signs its own caller assertion and forwards the principal;
   retry only when a request never reached a handler).
3. The aggregate prices the stay and records the house owner as host; the repository
   inserts it. Postgres' exclusion constraint rejects an overlapping confirmed booking
   atomically.
4. A violation becomes `ConflictError(BOOKING_DATES_UNAVAILABLE)` -> gRPC
   `ALREADY_EXISTS` + `google.rpc.ErrorInfo` -> HTTP 409 problem+json with `code`.
5. Every hop logs one JSON line with the same `requestId`; with OTLP configured, one trace
   spans the gateway, the three services and their SQL.

## Cross-cutting conventions

| Concern    | Convention                                                                                                                         | Where                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Errors     | `DomainError` kinds -> gRPC status + ErrorInfo/BadRequest -> RFC 9457                                                              | ADR-0003, `@ga/kernel`, kit `GrpcErrorFilter`, gateway `ProblemDetailsFilter` |
| Identity   | OIDC at the gateway; signed caller + principal per hop; `@Access` per RPC                                                          | ADR-0004, kit `auth/`, gateway `auth/`, `security/public-endpoints.json`      |
| Transport  | gRPC over TLS off loopback; host-name targets                                                                                      | kit `grpc/tls.ts`, `pnpm certs`                                               |
| Ids        | UUIDv7 from `IdGenerator`                                                                                                          | `@ga/kernel`, kit                                                             |
| Pagination | keyset on id, opaque filter-bound tokens, max 100                                                                                  | `@ga/kernel`                                                                  |
| Money      | integer minor units + ISO currency                                                                                                 | `@ga/kernel` `Money`, `ga.common.v1.Money`                                    |
| Config     | Zod schema per process, fail fast at boot                                                                                          | kit `parseConfig`                                                             |
| Logging    | pino JSON, one line per RPC/request, request id on every line                                                                      | kit, nestjs-pino                                                              |
| Tracing    | OpenTelemetry, enabled by `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                            | `@ga/service-kit/telemetry`                                                   |
| Health     | `grpc.health.v1` per service (DB-aware); gateway `/healthz`, `/readyz`                                                             | kit `HealthStatus`                                                            |
| Shutdown   | event drain (`EVENTS_DRAIN_MS`: relay and consumer) -> NOT_SERVING -> optional drain delay -> graceful gRPC shutdown -> close pool | kit                                                                           |
| Contracts  | one buf module, STANDARD lint, FILE breaking check, committed codegen                                                              | `packages/contracts`                                                          |
| Events     | outbox + relay, pull consumers deduped by event id, catalog as the ACL                                                             | ADR-0005, kit `events/`, `apps/event-bus-service`                             |

## Scaling to hundreds of services

- **Generation, not copying**: `pnpm new:service` keeps services identical;
  `pnpm template:verify` keeps the template green.
- **One chassis**: cross-cutting fixes land once in `@ga/service-kit`.
- **Catalog**: `services.json` is the registry of ports, databases and env names that local
  tooling consumes; at larger scale it becomes the service catalog (owners, tiers, SLOs).
- **Contract governance**: every proto change is linted and checked for breaking changes
  against `main`; versions are explicit (`v1`, `v2`).
- **Build cost**: Turborepo caches by content; only affected packages rebuild and retest.
- **Ownership**: `CODEOWNERS` already guards the security paths; add an entry per
  `apps/<service>` and per proto directory when teams form.
- **Secure by default**: a generated service authenticates every call, declares access per
  method, scopes its lists and ships the five access tests; making anything public is a
  reviewed allowlist change.
- **Skills as the spec**: the `ga-platform` plugin is the executable specification;
  update it in the same PR as the convention it documents.

## Decisions

- ADR-0001 Platform stack
- ADR-0002 Service boundaries and communication
- ADR-0003 API and error conventions
- ADR-0004 Identity and authorization
- ADR-0005 Asynchronous events
