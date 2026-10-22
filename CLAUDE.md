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
pnpm db:setup && pnpm stack:up && pnpm test:e2e       # whole system locally (PM2)
```

## Rules that break production when ignored

- Domain code (`src/domain`) imports only `@ga/kernel`; application code never imports
  Drizzle, gRPC or `@ga/contracts`. Ports are abstract classes bound in `app.module.ts`.
- Constructor-injected classes are value imports; `import type` only for interfaces and
  types. Never enable Biome's `useImportType`. No circular imports between injectables.
- Relative imports end in `.ts`. ESM everywhere.
- Fail with `DomainError` subclasses from `@ga/kernel` (stable UPPER_SNAKE reasons); their
  message and metadata reach API clients. Never throw HTTP/gRPC exceptions from domain or
  application code.
- Concurrency-sensitive invariants are Postgres constraints + `translateDbError`;
  read-modify-write is `UnitOfWork.run` + `forUpdate`. No remote calls inside a transaction.
- Database per service; other services' data only through their gRPC API; no call cycles.
- Never edit generated code (`packages/contracts/src/gen`) or applied migrations.
- Commit messages in English.

## Status

No authentication/authorization and no async messaging yet (ADR-0004, ADR-0005 in
`docs/architecture/adr/`). Everything binds to 127.0.0.1 locally; do not expose it.
