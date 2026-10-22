# house-service

gRPC service that owns **houses** (`ga.house.v1.HouseService`).
Generated from `templates/service` by `pnpm new:service`.

## Layout

| Path                  | Layer                                                     | May import                             |
| --------------------- | --------------------------------------------------------- | -------------------------------------- |
| `src/domain/`         | Entities, invariants, repository ports, domain errors     | `@ga/kernel` only                      |
| `src/application/`    | Use cases                                                 | domain, `@ga/kernel`, `@nestjs/common` |
| `src/infrastructure/` | Adapters: Drizzle repositories, clients of other services | anything                               |
| `src/transport/grpc/` | gRPC controller, request validation, mappers              | application, contracts                 |
| `src/app.module.ts`   | Composition root (binds ports to adapters)                | everything                             |
| `drizzle/`            | Generated SQL migrations (commit them)                    |                                        |
| `test/`               | Integration tests and fakes                               |                                        |

Contract: `packages/contracts/proto/ga/house/v1/house.proto`.

## Commands

```bash
pnpm --filter @ga/house-service test         # unit + gRPC/Postgres integration tests
pnpm --filter @ga/house-service db:generate  # schema.ts change -> new SQL migration
pnpm --filter @ga/house-service db:migrate   # apply migrations (needs a build)
pnpm --filter @ga/house-service dev          # watch mode
```

Configuration lives in `.env` (copied from `.env.example`) and is validated at boot by `src/config.ts`.
