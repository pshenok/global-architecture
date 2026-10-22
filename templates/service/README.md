# sample-item-service

gRPC service that owns **sample items** (`ga.sample_item.v1.SampleItemService`).
Generated from `templates/service` by `pnpm new:service`.

## Layout

| Path | Layer | May import |
|------|-------|-----------|
| `src/domain/` | Entities, invariants, repository ports, domain errors | `@ga/kernel` only |
| `src/application/` | Use cases | domain, `@ga/kernel`, `@nestjs/common` |
| `src/infrastructure/` | Adapters: Drizzle repositories, clients of other services | anything |
| `src/transport/grpc/` | gRPC controller, request validation, mappers | application, contracts |
| `src/app.module.ts` | Composition root (binds ports to adapters) | everything |
| `drizzle/` | Generated SQL migrations (commit them) | |
| `test/` | Integration tests and fakes | |

Contract: `packages/contracts/proto/ga/sample_item/v1/sample_item.proto`.

## Commands

```bash
pnpm --filter @ga/sample-item-service test         # unit + gRPC/Postgres integration tests
pnpm --filter @ga/sample-item-service db:generate  # schema.ts change -> new SQL migration
pnpm --filter @ga/sample-item-service db:migrate   # apply migrations (needs a build)
pnpm --filter @ga/sample-item-service dev          # watch mode
```

Configuration lives in `.env` (copied from `.env.example`) and is validated at boot by `src/config.ts`.
