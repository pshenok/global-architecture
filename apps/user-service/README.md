# user-service

gRPC service that owns **users** (`ga.user.v1.UserService`).
Generated from `templates/service` by `pnpm new:service`.

## Layout

| Path                         | Layer                                                     | May import                             |
| ---------------------------- | --------------------------------------------------------- | -------------------------------------- |
| `src/domain/`                | Entities, invariants, repository ports, domain errors     | `@ga/kernel` only                      |
| `src/application/`           | Use cases                                                 | domain, `@ga/kernel`, `@nestjs/common` |
| `src/infrastructure/`        | Adapters: Drizzle repositories, clients of other services | anything                               |
| `src/infrastructure/events/` | Outbox adapters of event ports (`Outbox.add`)             | anything                               |
| `src/transport/grpc/`        | gRPC controller, request validation, mappers              | application, contracts                 |
| `src/app.module.ts`          | Composition root (binds ports to adapters)                | everything                             |
| `drizzle/`                   | Generated SQL migrations (commit them)                    |                                        |
| `test/`                      | Integration tests and fakes                               |                                        |

Contract: `packages/contracts/proto/ga/user/v1/user.proto`.

## Events (ADR-0005)

- Publishes `ga.user.v1.UserDeletedEvent` (`user_events.proto`) when a user is deleted:
  `UserService.delete` calls the `UserEvents` port, whose adapter `OutboxUserEvents` adds
  the event to the `outbox` table in the delete's transaction; the kit's relay then
  publishes it to event-bus-service. Subscribers: house-service and booking-service.
- Consumes nothing, so there is no `src/transport/events/` and no `processed_events`.
- Table: `outbox`, declared in `schema.ts`. Tests: `test/user-events.spec.ts`.

## Commands

```bash
pnpm --filter @ga/user-service test         # unit + gRPC/Postgres integration tests
pnpm --filter @ga/user-service db:generate  # schema.ts change -> new SQL migration
pnpm --filter @ga/user-service db:migrate   # apply migrations (needs a build)
pnpm --filter @ga/user-service dev          # watch mode
```

Configuration lives in `.env` (copied from `.env.example`) and is validated at boot by `src/config.ts`.
