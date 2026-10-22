# ADR-0005: Asynchronous events

- Status: Proposed (not implemented)
- Date: 2026-10-22

## Context

Some reactions cannot be synchronous calls without creating cycles or coupling: when a
house is deleted, booking-service should cancel its future bookings; when a user is
deleted, their data elsewhere must be handled. Today these cases are not reconciled.

## Proposal

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

## Consequences

Cross-service consistency becomes eventual and observable (lag, dead letters). Each
service owns its reactions. Call cycles are no longer needed for back-references.
