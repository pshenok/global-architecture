# booking-service

gRPC service that owns **bookings** (`ga.booking.v1.BookingService`).
Generated from `templates/service` by `pnpm new:service`.

## Layout

| Path                    | Layer                                                     | May import                             |
| ----------------------- | --------------------------------------------------------- | -------------------------------------- |
| `src/domain/`           | Entities, invariants, repository ports, domain errors     | `@ga/kernel` only                      |
| `src/application/`      | Use cases                                                 | domain, `@ga/kernel`, `@nestjs/common` |
| `src/infrastructure/`   | Adapters: Drizzle repositories, clients of other services | anything                               |
| `src/transport/grpc/`   | gRPC controller, request validation, mappers              | application, contracts                 |
| `src/transport/events/` | `@OnEvent` handlers: `currentService()` to one use case   | application, contracts                 |
| `src/app.module.ts`     | Composition root (binds ports to adapters)                | everything                             |
| `drizzle/`              | Generated SQL migrations (commit them)                    |                                        |
| `test/`                 | Integration tests and fakes                               |                                        |

Contract: `packages/contracts/proto/ga/booking/v1/booking.proto`.

## Events (ADR-0005)

- Publishes nothing.
- Consumes `ga.house.v1.HouseDeletedEvent` (`HouseEventsConsumer` ->
  `cancelOpenStaysOfHouse`) and `ga.user.v1.UserDeletedEvent` (`UserEventsConsumer` ->
  `cancelOpenStaysOfGuest`). Both cancel the open stays (CONFIRMED bookings that check
  out after today, UTC) and free their dates; finished stays stay as history. A deleted
  user's hosted stays go with its houses (`HouseDeletedEvent`), not with
  `UserDeletedEvent`.
- Table: `processed_events` (event ids already applied, kept 30 days), declared in
  `schema.ts`; no `outbox`. Tests: `test/booking-events.spec.ts`.

## Commands

```bash
pnpm --filter @ga/booking-service test         # unit + gRPC/Postgres integration tests
pnpm --filter @ga/booking-service db:generate  # schema.ts change -> new SQL migration
pnpm --filter @ga/booking-service db:migrate   # apply migrations (needs a build)
pnpm --filter @ga/booking-service dev          # watch mode
```

Configuration lives in `.env` (copied from `.env.example`) and is validated at boot by `src/config.ts`.
