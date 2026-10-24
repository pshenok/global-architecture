# ADR-0005: Asynchronous events

- Status: Accepted
- Date: 2026-10-23
- Amends: the proposal of 2026-10-22 (kept below as "Original proposal"); the open broker decision is decided here

## Context

Some reactions cannot be synchronous calls without creating cycles or coupling: when a
house is deleted, booking-service should cancel its open bookings; when a user is
deleted, their houses and bookings must be handled. Today neither is reconciled
(ADR-0002 Consequences, ADR-0004 Consequences).

Constraints at the time of the decision:
- The whole system runs on a laptop with PM2 and one local Postgres, and CI runs the same
  stack with a Postgres service only: no Docker, NATS or Kafka.
- Synchronous calls form a DAG (ADR-0002 #3), no remote call runs while a transaction is
  open (ADR-0002 #5), and every database is private to its service (ADR-0002 #1).
- Every call is authenticated per hop; jobs and event consumers call as themselves with
  `@Access.service([...])` and carry no user principal (ADR-0004).
- The platform will grow to hundreds of services: services must not depend on which
  queue technology is used, so it can change without touching them.

## Decision

1. **Our own pub/sub workload.** `event-bus-service` is an ordinary platform service
   (gRPC `ga.event_bus.v1.EventBusService`, database `ga_event_bus`, registered in
   `services.json`). Its API is `Publish`, `Pull`, `Ack` and `Nack`. It is the only
   component that knows which queue stores events.
2. **Transactional outbox in every producer.** A use case records a domain event through
   a port in its own terms (`HouseEvents.deleted`); the adapter calls the kit's
   `Outbox.add(event, aggregateId, payload)`, which inserts an `outbox` row in the current
   `UnitOfWork` transaction and refuses to run outside one. The event exists if and only
   if the change committed. Use cases never call the bus.
3. **Relay in the producer process.** The kit's relay claims committed rows (`FOR UPDATE
   SKIP LOCKED`, by availability and a lease token, never by an id cursor), commits the
   claim, publishes one batch per tick with no transaction open, deletes the rows the bus
   accepted and backs off the rest. It never drops a row: a refusal (for example an event
   type the bus catalog does not know yet) is retried with capped backoff and logged as an
   error until the catalog is deployed.
4. **Pull delivery; the bus is a sink.** Consumers pull the event types they handle (at
   most 50 per service: one Pull carries at most 50, and the kit fails boot with more);
   the bus calls no service, so no event flow adds a synchronous edge that could close a
   cycle. A pulled delivery is leased; an unsettled one returns when its lease ends.
   `check-call-graph` enforces the call graph at lint time, and `GrpcClientsModule.register`
   works on frozen copies of its definitions, so a client signs only for the target that
   register() validated and the checker read, whatever its `url()` does. At run time the
   kit's `WorkloadIdentity` enforces it from both ends: it signs no caller assertion as
   event-bus-service, and every service refuses a caller assertion that event-bus-service
   issued (`UNAUTHENTICATED` `CALLER_INVALID`, public methods included), even one the
   bus's code signed with its key directly. A call without an assertion fails with
   `CALLER_MISSING`, and the bus holds no other workload's private key, so the bus cannot
   call a gRPC service whatever code it contains (health checks and reflection, which
   change nothing, answer anyone).
5. **Contracts.** The envelope (`ga.event_bus.v1.Event`) carries the event id (UUIDv7,
   the producer's outbox row id), the type (the payload's full protobuf name, which is
   also the topic), the aggregate id, the occur time, the request id and the W3C
   traceparent, plus the payload as protobuf bytes. Payloads are `ga.<domain>.v<N>.<Fact>Event`
   messages in `ga/<domain>/v<N>/<domain>_events.proto`, owned by one producer, carrying
   domain facts and ids only, never PII or a principal. Changes are additive; an
   incompatible change is a new `v2` type published alongside `v1` until every
   subscriber has moved.
6. **Ownership and access.** Every bus method is `@Access.service([...])` with inline
   lists and an entry in `security/public-endpoints.json`. A static topic catalog in the
   bus (`apps/event-bus-service/src/domain/topics.ts`, CODEOWNERS) names, per event type,
   the one producer allowed to publish it and the subscribers that receive it: a listed
   producer cannot publish another domain's event. The producer stored with an event is
   the verified caller of `Publish`. Event descriptors (`defineEvent(type, { producer })`)
   repeat the owner, so the kit refuses to record a foreign event and dead-letters a
   delivery from an unexpected producer.
7. **Idempotent consumers.** The kit runs each delivery in a fresh request context whose
   actor is the consuming service itself (`currentService()`), with no principal and the
   envelope's request id; the producer and attempt are available through
   `currentEvent()`. Handlers are `@OnEvent(descriptor)` methods that receive the decoded
   payload and call one use case. In one local transaction
   it inserts `(subscription, event_id)` into `processed_events` and runs the handler;
   a duplicate skips the handler. Handlers make no remote calls: the kit refuses any
   outbound gRPC call while a transaction is open. Delivery is at least once and
   unordered, so handlers must be commutative (filter by state, delete what still exists).
8. **Retries and dead letters.** The kit classifies handler failures: concurrency,
   dependency and rate-limit errors (database serialization failures, deadlocks and
   timeouts included) and unknown errors are retried with the bus's backoff (1 s doubling
   to 300 s); other domain errors, undecodable payloads, unexpected producers and remote
   calls inside the handler's transaction are dead-lettered at once. After
   `EVENT_BUS_MAX_ATTEMPTS` (10) leases a delivery is dead, also when the consumer keeps
   crashing without settling it. `pnpm events:status` shows lag and dead letters;
   `events:redrive` returns dead letters to pending, `events:replay` backfills, and
   `events:drop` deletes the deliveries of a pair the catalog no longer lists. Delivered
   events are kept for `EVENT_BUS_RETENTION_DAYS` (7, at most 21), and a replay queues
   only events from the last 21 days, because consumers remember processed ids for 30.
9. **The queue behind two ports.** Inside the bus, two ports are the only code that
   touches storage: `EventBroker` (provision, publish, pull, ack, nack: delivery) and
   `EventBrokerAdmin` (queues, redrive, replay, drop, purgeDelivered: the `events:*`
   commands and retention). Adapters only store; the catalog rules sit above the ports, in
   `EventBusService` (the RPCs) and `EventBusAdmin` (the commands), the same for every
   backend. The first adapters are Postgres (`PostgresEventBroker`,
   `PostgresEventBrokerAdmin`; `events` and `deliveries` tables). Another backend
   implements both ports, passes both contract suites (`describeEventBroker` in
   `test/event-broker.contract.ts`, `describeEventBrokerAdmin` in
   `test/event-broker-admin.contract.ts`) and is bound by a literal switch on a config
   enum, in `app.module.ts` and in the CLI (`src/cli/bus.ts`), which boots no service and
   builds its admin adapter itself. Changing the backend redeploys the bus only. A sketch
   for NATS JetStream and Kafka follows this list.
10. **Operations.** Asynchronous parts register no health checks (a failing check would
    take a healthy API out of rotation); lag and dead letters show in logs and
    `events:status`. Relay and consumer stop claiming and drain in `onModuleDestroy`,
    within `EVENTS_DRAIN_MS`, before the pool and clients close.
11. **First reactions.** `ga.house.v1.HouseDeletedEvent` makes booking-service cancel the
    house's open stays. `ga.user.v1.UserDeletedEvent` makes house-service delete the
    user's houses (one `HouseDeletedEvent` each, in the same transaction) and makes
    booking-service cancel the user's open stays as a guest. An open stay is a CONFIRMED
    booking whose check-out is after today (UTC); finished stays stay as history.

### Sketch: NATS JetStream and Kafka behind the ports (not built)

A sketch for a future adapter, not a tested design: check each point against the
broker's documentation, and let the two contract suites decide.
- **Provision.** JetStream: one stream with every event type as a subject (limits
  retention), a dead-letter stream (`dead.<subscriber>.<type>`), and one durable pull
  consumer per (subscriber, type) filtering the type and `to.<subscriber>.<type>` (where
  redrives and replays for that subscriber go), with explicit acks and deliver-new, so a
  new subscriber gets events from then on. Kafka: a topic per type, `to.` and `dead.`
  topics per pair, and a share group (KIP-932) per pair starting at the latest offset.
- **Publish dedupe.** JetStream dedupes `Nats-Msg-Id` (the event id) within the stream's
  duplicate window; Kafka has no dedupe by id (the idempotent producer drops only its own
  retries). Both need a small id store (event id -> digest of type, producer and payload)
  to answer `duplicate` and `reused`.
- **Pull and lease.** JetStream: a no-wait fetch of at most `max` from the pairs'
  consumers, `AckWait` = `EVENT_BUS_LEASE_S`. Kafka: a share consumer's poll, with the
  acquisition lock (`group.share.record.lock.duration.ms`) as the lease. In both the
  delivery count is the attempt.
- **Receipt and ack.** JetStream: the receipt is the message's ack subject, which any bus
  replica can publish to; an ack from an earlier delivery must stay a no-op. Kafka: only
  the consumer that acquired a record can accept it, so Ack and Nack must reach the bus
  replica that served the Pull (the receipt names it), or each subscriber is pinned to one
  replica.
- **Nack with backoff.** JetStream: a nak with a delay of `retryDelayMs(attempt)`. Kafka:
  a release redelivers at once, so a backoff needs a retry hop: accept, then produce a
  copy to `to.<subscriber>.<type>` with a not-before time and the attempt in headers.
- **Max attempts and dead letters.** JetStream: `MaxDeliver` = attempts + 1; a nack on
  the last attempt or one asking for it, and a pulled message past the limit (its last
  lease ran out), are copied to the dead-letter stream and terminated. Kafka: the same
  cases produce to `dead.<subscriber>.<type>` and accept, before
  `group.share.delivery.count.limit` (attempts + 1) archives the record. Either way a
  dead letter keeps its own copy of the event.
- **Retention.** Logs delete a prefix, not single events: `purgeDelivered` purges each
  stream or partition below its lowest unsettled position and the age cutoff (JetStream
  purge up to a sequence, Kafka `deleteRecords`). Age limits (`MaxAge`, `retention.ms`)
  delete pending deliveries too, so only as a far backstop.
- **Admin.** `queues`: pending from each consumer's or share group's unsettled count,
  dead from the dead-letter subject (JetStream) or topic past a redrive cursor (Kafka),
  the oldest pending time from the first unsettled message. `redrive`: copy dead letters to `to.<subscriber>.<type>` as new messages (fresh
  attempts), then purge them or move the cursor. `replay`: read the type from `since`
  (start time, `offsetsForTimes`) and copy to `to.<subscriber>.<type>`. `drop`: delete the
  pair's consumer or share group and its dead letters.
- **Gaps.** Neither broker knows which events a subscriber already holds, which `replay`
  skips: the adapter keeps that index. The harnesses move time (`elapse`, `backdate`) that
  these brokers stamp themselves, and the purge case deletes events out of publish order:
  a log adapter needs its own clock and a log-shaped variant of that case. Stored events
  do not move between backends: switch once `events:status` shows nothing pending.

## Consequences

- Cleanup after deletes becomes eventual: about one second per hop locally, two to three
  seconds for user -> house -> booking. Lag and dead letters are observable, not silent.
- Each event is written twice (producer outbox, bus storage) and crosses one extra hop;
  a bus outage only grows outbox backlogs and consumer lag, synchronous APIs keep working.
- Every new event type, producer or subscriber edits the reviewed topic catalog; a
  workload that joins or leaves the bus also edits the bus methods' `@Access.service`
  lists and `security/public-endpoints.json`.
- The bus is trusted like any broker: envelopes are not signed by producers, because
  workload public keys are pruned 120 s after rotation (ADR-0004) and events can be
  retried or redriven days later. Someone with write access to `ga_event_bus` could forge
  a delivery; replays within the 30 days `processed_events` remembers an id are absorbed,
  forgeries are not.
- A booking or house created between a create's existence check and the cleanup can stay
  orphaned (creates check, then insert without a lock). Tombstones checked on create are
  the follow-up if this matters.
- Polling (500 ms) costs a few cheap queries per second per process even when idle;
  LISTEN/NOTIFY or long-poll can be added inside the Postgres adapter later.
- No ordering guarantee: per-aggregate ordering, if ever needed, is a broker option with
  head-of-line blocking.

## Alternatives considered

- **A broker library in every service** (a kit transport port with NATS/Kafka adapters):
  drivers, credentials and topology in every deployable, and a backend change redeploys
  everything. Rejected.
- **Push delivery** (the bus calls consumers' `@Access.service` methods): adds edges such
  as booking -> house -> bus -> booking. Rejected.
- **Relay inside the bus reading producers' outbox tables**: breaks database per service.
  Rejected.
- **Kit-owned migrations for the event tables**: `runMigrations` and `createTestDatabase`
  apply one folder each; the two small tables are copied into each service's
  `schema.ts` instead. The boot check covers the tables, the kit's columns and
  `processed_events`' unique key, not types, defaults or other indexes.
- **Producer-signed envelopes, LISTEN/NOTIFY, long-poll, batch acks of offsets**:
  deferred; each can be added without breaking the contract.

## Original proposal (2026-10-22)

1. **Transactional outbox.** A service writes its domain event to an `outbox` table in
   the same transaction as the state change, so the event exists if and only if the
   change committed.
2. **Relay.** A relay (polling with `FOR UPDATE SKIP LOCKED`, or logical decoding) publishes
   outbox rows to a broker (NATS JetStream or Kafka; open decision) and marks them sent.
3. **Contracts.** Events are protobuf messages in `packages/contracts` (`ga.<domain>.v1`
   `*Event`), versioned and breaking-checked like RPCs, carrying an event id, occurred-at
   time and the aggregate id.
4. **Consumers** are idempotent: they record processed event ids in their own database in
   the same transaction as their effect, and tolerate out-of-order delivery.
5. The service kit gains `OutboxModule` and a consumer bootstrap so every service does it
   the same way.
