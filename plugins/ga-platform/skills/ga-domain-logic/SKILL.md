---

name: ga-domain-logic
description: How to write business logic inside a global-architecture service with clean architecture - aggregates and invariants in src/domain, use cases in src/application, ports as abstract classes, DomainError kinds and reasons, validation split between transport and domain, UnitOfWork transactions, ids and time. Use it whenever you add or change a business rule, entity, aggregate, use case, error, status/state machine or validation in any *-service, or when deciding which layer a piece of code belongs to.
---

# Domain and application layers

Business logic must be testable without Nest, gRPC or Postgres, and portable if the
transport or ORM changes. That is why `src/domain` is plain TypeScript and
`src/application` only orchestrates through ports.

## Anatomy (booking-service is the richest example)

```
src/domain/booking.ts            aggregate: state, create(), restore(), behaviour (cancel)
src/domain/stay.ts               value logic (date rules) as pure functions
src/domain/booking.errors.ts     error factories: bookingNotFound(id), datesUnavailable(houseId)
src/domain/booking.repository.ts persistence port (abstract class)
src/application/booking.service.ts            use cases
src/application/ports/house-catalog.ts        port for another service's data
```

## Aggregates

```ts
export class House {
  private constructor(private state: HouseState) {}
  static create(input: {...}, now: Date): House  // validates and normalizes everything
  static restore(state: HouseState): House       // rebuilds from storage; trusts the DB
  update(changes: HouseChanges, now: Date): void // behaviour enforces invariants
  toState(): HouseState                          // copy out for persistence and mapping
}
```

- State is private and only changes through intention-revealing methods
  (`cancel(now)`, `update(changes, now)`), so invariants cannot be bypassed.
- `now` is a parameter: the use case passes `this.clock.now()`, tests pass a fixed date.
- Normalize at the boundary of the aggregate (trim, lower-case emails, upper-case
  country codes) so stored data is canonical.
- Return copies from `toState()`; never hand out the mutable state.
- A state machine is a method that checks the current state:
  `if (this.state.status === 'CANCELLED') throw bookingAlreadyCancelled(id)`.
- Rules that span many aggregates or need atomicity under concurrency (uniqueness,
  no-overlap) belong to the database (`ga-database`), not to an in-memory check.

## Errors: pick the kind by what the caller should do

| Throw                                            | gRPC / HTTP               | When                                                                                                     |
| ------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ValidationError(message, violations)`           | INVALID_ARGUMENT / 400    | input is malformed regardless of system state                                                            |
| `NotFoundError(reason, msg, meta)`               | NOT_FOUND / 404           | the addressed resource does not exist                                                                    |
| `ConflictError`                                  | ALREADY_EXISTS / 409      | a conflicting resource exists (unique key, overlapping range)                                            |
| `PreconditionFailedError`                        | FAILED_PRECONDITION / 400 | valid input, but the system state forbids it (cancelled twice, referenced user missing, too many guests) |
| `ConcurrencyError`                               | ABORTED / 409             | lost a race (serialization failure); safe to retry                                                       |
| `DependencyUnavailableError`                     | UNAVAILABLE / 503         | another service or the DB is down; nothing was changed                                                   |
| `PermissionDeniedError` / `UnauthenticatedError` | 403 / 401                 | reserved for the auth work (see ADR-0004)                                                                |

Write a factory per error in `<noun>.errors.ts` with a stable UPPER_SNAKE `reason`
prefixed by the aggregate (`BOOKING_DATES_UNAVAILABLE`). Clients branch on `reason`,
so never change an existing one. Messages and metadata are returned to API clients:
write them for API users, include only identifiers the caller already knows.

## Validation: two layers, two jobs

1. **Transport** (`src/transport/grpc/*.requests.ts`, Zod + `parseRequest`): shape and
   format. Is `id` a UUID, is `email` an email, are numbers integers within range.
   Rejects garbage before any work and returns precise field violations.
2. **Domain** (aggregate methods): business invariants, using the same limits, because
   the domain must protect itself whoever calls it.

The duplication of a few limits (max lengths) is intentional; export the constants from
the domain file when you want one source.

## Use cases

```ts
@Injectable()
export class BookingService {
  constructor(
    private readonly bookings: BookingRepository, // ports: abstract classes
    private readonly users: UserDirectory,
    private readonly houses: HouseCatalog,
    private readonly ids: IdGenerator, // from @ga/kernel, bound by the kit
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
  ) {}
}
```

- One public method per use case; it reads like the business process.
- Do cheap local validation before remote calls; run independent remote calls in
  parallel (`Promise.all`).
- **Never hold a database transaction open across a remote call.**
- Read-modify-write goes inside `this.unitOfWork.run(...)` with
  `findById(id, { forUpdate: true })`, so concurrent updates serialize instead of
  overwriting each other. Repositories called inside `run()` join the transaction
  automatically; nested `run()` becomes a savepoint.
- Single-statement writes (insert, delete) do not need a unit of work.
- Imports allowed: domain, `@ga/kernel`, `@nestjs/common` (`Injectable`, `Logger`).
  Constructor parameters that are classes must be **value imports** (DI metadata);
  only interfaces/types use `import type`.

## Ports

A port is an abstract class named after what the domain needs, not after the provider:
`UserDirectory.exists(id)`, `HouseCatalog.findTerms(id)`, not `UserServiceClient`.
Keep the port's return types in domain terms (`HouseTerms`), which makes the adapter an
anti-corruption layer and keeps another service's contract out of your domain.
Bind it in `app.module.ts`: `{ provide: HouseCatalog, useClass: GrpcHouseCatalog }`.

## Logging inside use cases

```ts
private readonly logger = new Logger(BookingService.name);
this.logger.log(`booking ${id} cancelled`);
```

The request id is attached automatically. Every RPC already gets one structured line
with method, status and duration, so log business events, not entry/exit. Never log
emails, names or tokens.
