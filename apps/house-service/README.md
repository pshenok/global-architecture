# house-service

gRPC service that owns **houses** (`ga.house.v1.HouseService`).
Generated from `templates/service` by `pnpm new:service`.

## Layout

| Path                         | Layer                                                     | May import                             |
| ---------------------------- | --------------------------------------------------------- | -------------------------------------- |
| `src/domain/`                | Entities, invariants, repository ports, domain errors     | `@ga/kernel` only                      |
| `src/application/`           | Use cases                                                 | domain, `@ga/kernel`, `@nestjs/common` |
| `src/infrastructure/`        | Adapters: Drizzle repositories, clients of other services | anything                               |
| `src/infrastructure/events/` | Outbox adapters of event ports (`Outbox.add`)             | anything                               |
| `src/transport/grpc/`        | gRPC controller, request validation, mappers              | application, contracts                 |
| `src/transport/events/`      | `@OnEvent` handlers: `currentService()` to one use case   | application, contracts                 |
| `src/app.module.ts`          | Composition root (binds ports to adapters)                | everything                             |
| `drizzle/`                   | Generated SQL migrations (commit them)                    |                                        |
| `test/`                      | Integration tests and fakes                               |                                        |

Contract: `packages/contracts/proto/ga/house/v1/house.proto`.

## Events (ADR-0005)

- Publishes `ga.house.v1.HouseDeletedEvent` (`house_events.proto`) for every deleted
  house, through the `HouseEvents` port: `OutboxHouseEvents` adds it to the `outbox` table
  in the delete's transaction and the kit's relay publishes it. Subscriber:
  booking-service.
- Consumes `ga.user.v1.UserDeletedEvent`: `UserEventsConsumer` calls
  `HouseService.removeAllOf`, which deletes the owner's houses and records one
  `HouseDeletedEvent` per house, in one transaction.
- Tables: `outbox` and `processed_events` (event ids already applied, kept 30 days),
  declared in `schema.ts`. Tests: `test/house-events.spec.ts`.

## Commands

```bash
pnpm --filter @ga/house-service test         # unit + gRPC/Postgres integration tests
pnpm --filter @ga/house-service db:generate  # schema.ts change -> new SQL migration
pnpm --filter @ga/house-service db:migrate   # apply migrations (needs a build)
pnpm --filter @ga/house-service dev          # watch mode
```

Configuration lives in `.env` (copied from `.env.example`) and is validated at boot by `src/config.ts`.
