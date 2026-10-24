# event-bus-service

The platform's publish/subscribe service (`ga.event_bus.v1.EventBusService`, ADR-0005).
Producers publish from their transactional outbox; consumers pull, process each event
in their own transaction and acknowledge it. The bus calls no service, and no service
ever talks to a queue: which store holds the events is private to this service.

## Layout

| Path                                    | What                                                        |
| --------------------------------------- | ----------------------------------------------------------- |
| `src/domain/topics.ts`                  | The event catalog: who publishes each type, who receives it |
| `src/domain/retry.ts`                   | Backoff of failed deliveries                                |
| `src/application/event-bus.service.ts`  | Publish, Pull, Ack, Nack use cases (catalog checks)         |
| `src/application/ports/event-broker.ts` | `EventBroker`: the seam a queue plugs into                  |
| `src/infrastructure/persistence/`       | `PostgresEventBroker` (default backend), schema, migrations |
| `src/infrastructure/retention.ts`       | Deletes delivered events after `EVENT_BUS_RETENTION_DAYS`   |
| `src/transport/grpc/`                   | Controller (`@Access.service` lists), request limits        |
| `src/cli/`                              | `pnpm events:status`, `events:redrive`, `events:replay`     |
| `test/event-broker.contract.ts`         | The semantics every backend must pass                       |

Contract: `packages/contracts/proto/ga/event_bus/v1/event_bus.proto`.

## Delivery

At least once, unordered. A delivery is leased for `EVENT_BUS_LEASE_S` (30 s) per Pull;
Nack retries it after 1 s, 2 s, 4 s ... (at most 5 min); after `EVENT_BUS_MAX_ATTEMPTS`
(10) leases, or a Nack with `dead_letter`, it becomes a dead letter, which stays until
someone redrives it. Consumers deduplicate by event id (the kit's `processed_events`).

## Adding an event type, a producer or a subscriber

1. The payload message: `ga/<domain>/v<N>/<domain>_events.proto` in the producer's
   package, named `<Aggregate><PastFact>Event` (the `ga-grpc-contracts` skill).
2. The catalog entry in `src/domain/topics.ts` (code owners review it).
3. If the producer or subscriber is new to the bus: its name in the `@Access.service`
   lists of `event-bus.grpc-controller.ts` (Publish for producers; Pull, Ack and Nack
   for subscribers) and the same lists in `security/public-endpoints.json`. A test
   fails while the three disagree.
4. The producer records the event through `Outbox.add`, the subscriber handles it with
   `@OnEvent` (the `ga-service-communication` skill).
5. A new subscriber receives only events published from then on;
   `pnpm events:replay --subscriber <it> --type <fqn> --since <time>` backfills
   retained ones.

## Another queue behind the bus

Write an `EventBroker` adapter in `src/infrastructure/<backend>/`, run
`describeEventBroker` from `test/event-broker.contract.ts` against it, and bind it in
`app.module.ts` (a config switch once there are two). Nothing outside this service
changes. ADR-0005 sketches NATS JetStream and Kafka mappings.

## Commands

```bash
pnpm --filter @ga/event-bus-service test         # contract suite, access tests, CLI
pnpm --filter @ga/event-bus-service db:generate  # schema.ts change -> new SQL migration
pnpm events:status                               # lag and dead letters per subscriber
pnpm events:redrive --subscriber booking-service [--type ga.house.v1.HouseDeletedEvent]
pnpm events:replay --subscriber house-service --type ga.user.v1.UserDeletedEvent --since 2026-10-01T00:00:00Z
```

Configuration lives in `.env` (copied from `.env.example`) and is validated at boot by
`src/config.ts`.
