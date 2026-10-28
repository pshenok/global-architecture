# event-bus-service

The platform's publish/subscribe service (`ga.event_bus.v1.EventBusService`, ADR-0005).
Producers publish from their transactional outbox; consumers pull, process each event
in their own transaction and acknowledge it. The bus calls no service, and no service
ever talks to a queue: which store holds the events is private to this service.

## Layout

| Path                                          | What                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `src/domain/topics.ts`                        | The event catalog: who publishes each type, who receives it                 |
| `src/domain/retry.ts`                         | Backoff of failed deliveries                                                |
| `src/domain/retention.ts`                     | Retention cap and replay window (21 days)                                   |
| `src/application/event-bus.service.ts`        | Publish, Pull, Ack, Nack use cases (catalog checks)                         |
| `src/application/event-bus-admin.ts`          | Status, redrive, replay, drop for the CLI (catalog checks)                  |
| `src/application/ports/event-broker.ts`       | `EventBroker`: delivery, the seam a queue plugs into                        |
| `src/application/ports/event-broker-admin.ts` | `EventBrokerAdmin`: operator and retention work, the rest of the seam       |
| `src/infrastructure/persistence/`             | `PostgresEventBroker`, `PostgresEventBrokerAdmin` (default backend), schema |
| `drizzle/`                                    | SQL migrations of the Postgres backend                                      |
| `src/infrastructure/retention.ts`             | Deletes delivered events after `EVENT_BUS_RETENTION_DAYS`                   |
| `src/transport/grpc/`                         | Controller (`@Access.service` lists), request limits                        |
| `src/cli/`                                    | `pnpm events:*`: status, redrive, replay, drop                              |
| `test/event-broker.contract.ts`               | The delivery semantics every backend must pass                              |
| `test/event-broker-admin.contract.ts`         | The operator and retention semantics every backend must pass                |

Contract: `packages/contracts/proto/ga/event_bus/v1/event_bus.proto`.

## Delivery

At least once, unordered. A delivery is leased for `EVENT_BUS_LEASE_S` (30 s) per Pull;
Nack retries it after 1 s, 2 s, 4 s ... (at most 5 min); after `EVENT_BUS_MAX_ATTEMPTS`
(10) leases, or a Nack with `dead_letter`, it becomes a dead letter, which stays until
someone redrives it. Consumers deduplicate by event id (the kit's `processed_events`,
kept 30 days), so `EVENT_BUS_RETENTION_DAYS` (7) is capped at 21: a replayed event must
still be remembered by every consumer that already applied it. For the same reason
`events:replay` queues only events from the last 21 days; older ones that another
subscriber's delivery still keeps are skipped and counted. Run a replay while the
subscriber is consuming: a replayed delivery still unprocessed 9 days later (30 - 21)
could run its handler twice.

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

To retire a type or a subscriber (a v1 type once every subscriber handles v2, or a
subscriber leaving a topic): when `pnpm events:status` shows nothing pending for the
pair, deploy the consumer without its handler (Pull refuses a type the catalog does not
list), then remove the pair from the catalog (and the workload from the `@Access` lists
if it leaves the bus) and deploy the bus. `events:status` then marks leftover rows
`orphaned`: nothing leases or redrives them (the subscriber's next pull still turns one
whose last lease ran out into a dead letter), and they keep their events from retention,
so delete them with `pnpm events:drop --subscriber <it> --type <fqn>`.

## Another queue behind the bus

Implement both ports in `src/infrastructure/<backend>/`: `EventBroker` (delivery) and
`EventBrokerAdmin` (status, redrive, replay, drop, retention). Run both contract suites
against them, `describeEventBroker` from `test/event-broker.contract.ts` and
`describeEventBrokerAdmin` from `test/event-broker-admin.contract.ts`, and bind both in
`app.module.ts` (a config switch once there are two); `src/cli/bus.ts` builds the admin
adapter itself. The catalog rules stay in `EventBusService` and `EventBusAdmin`, so an
adapter only stores. Nothing outside this service changes.

## Commands

```bash
pnpm --filter @ga/event-bus-service test         # contract suites, access tests, CLI
pnpm --filter @ga/event-bus-service db:generate  # schema.ts change -> new SQL migration
pnpm events:status                               # lag and dead letters per subscriber
pnpm events:redrive --subscriber booking-service [--type ga.house.v1.HouseDeletedEvent]
pnpm events:replay --subscriber house-service --type ga.user.v1.UserDeletedEvent --since 2026-10-01T00:00:00Z
pnpm events:drop --subscriber <workload> --type <fqn>   # only a pair the catalog no longer lists
```

Configuration lives in `.env` (copied from `.env.example`) and is validated at boot by
`src/config.ts`.
