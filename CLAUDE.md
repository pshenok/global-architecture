# global-architecture

Monorepo of Node 26 / NestJS 12 gRPC microservices behind one HTTPS REST gateway, built
from one service template on one shared chassis. Read the `ga-architecture` skill before
changing anything; it maps the repo and links the other `ga-*` skills.

## Commands

```bash
pnpm install                    # pinned Node 26 + pnpm 12 are fetched automatically
pnpm check                      # biome + oxlint + typecheck + tests
pnpm build                      # SWC build (turbo-cached); runs an ESM link check per package
pnpm new:service <noun>         # new service from templates/service
pnpm --filter @ga/contracts codegen   # after editing any .proto
pnpm --filter @ga/<svc> db:generate --name <change>   # after editing schema.ts
pnpm stack:up && pnpm test:e2e  # whole system locally (PM2): certs, keys, dev IdP, DBs, migrations, health
pnpm dev:token alice --email alice@example.com   # access token from the local dev IdP
pnpm grpc:call house-service ListHouses '{}' --as <userId>   # call a service as the platform does
pnpm users:grant-role <userId> admin            # platform roles live in user-service (users:revoke-role)
pnpm events:status                              # event lag and dead letters (events:redrive, events:replay)
```

## Rules that break production when ignored

- Domain code (`src/domain`) imports only `@ga/kernel`; application code never imports
  Drizzle, gRPC or `@ga/contracts`. Ports are abstract classes bound in `app.module.ts`.
- Constructor-injected classes are value imports; `import type` only for interfaces and
  types. Never enable Biome's `useImportType`. No circular imports (Biome fails them).
- Relative imports end in `.ts`. ESM everywhere.
- Fail with `DomainError` subclasses from `@ga/kernel` (stable UPPER_SNAKE reasons); their
  message and metadata reach API clients. Never throw HTTP/gRPC exceptions from domain or
  application code.
- Concurrency-sensitive invariants are Postgres constraints + `translateDbError`;
  read-modify-write is `UnitOfWork.run` + `forUpdate`. No remote calls inside a transaction.
- Database per service; other services' data only through their gRPC API; no call cycles
  (`check-call-graph` in `pnpm lint`).
- Asynchronous reactions are events (ADR-0005): publish only through a domain-named port
  whose adapter calls `Outbox.add` inside `UnitOfWork.run`; consume only with `@OnEvent`
  in `src/transport/events`, passing `currentService()` to one use case; handlers are
  idempotent, order-independent and make no remote calls (the kit refuses calls inside a
  transaction). A new event type, producer or subscriber edits the catalog in
  event-bus-service. Never talk to a queue directly.
- Every gRPC method declares `@Access` (`user`, `admin`, `identity`, `service`, or
  `public(reason)` listed in `security/public-endpoints.json`); a service with an
  undeclared method does not start. Never weaken the guard or add an auth bypass.
- Never take the acting user's id from a request: controllers pass `currentUser()` as
  the use case's first argument; rules live in the domain. Answer NOT_FOUND when the
  caller may not know a resource exists; lists take a typed scope.
- Never cast to `UserActor`/`IdentityActor`/`ServiceActor` or build `x-ga-*` metadata;
  the service kit does both (`check-access` in `pnpm lint` enforces it).
- Never edit generated code (`packages/contracts/src/gen`) or applied migrations.
- Commit messages in English.

## Status

Authentication and authorization are in place (ADR-0004): OIDC at the gateway, signed
caller and principal tokens between services, gRPC TLS off loopback. Asynchronous events
are live (ADR-0005): deleting a user or a house cleans up its houses and bookings within
seconds, through event-bus-service.
