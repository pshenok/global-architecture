# ADR-0002: Service boundaries and communication

- Status: Accepted
- Date: 2026-10-22

## Context

The platform must grow to hundreds of services owned by different teams without
turning into a distributed monolith.

## Decision

1. **Database per service.** A service's tables are private. No shared schemas, no
   cross-service foreign keys, no reporting queries into another service's database.
   References to another service's entities are plain ids (`owner_id`, `guest_id`).
2. **Synchronous calls are gRPC** through typed clients from `@ga/contracts`, with a
   default deadline, request-id propagation and retries only for transport-level
   `UNAVAILABLE` (`GrpcClientsModule`). A handler that itself reports `UNAVAILABLE`
   (`DependencyUnavailableError`) sends `grpc-retry-pushback-ms: -1`, so outages are not
   amplified by retries at every hop. Deadlines do not cancel the callee's work.
3. **Dependencies form a directed acyclic graph.** A call that would close a cycle must be
   an event instead (ADR-0005).
4. **Ports and adapters at the boundary.** A service depends on another service through a
   port named in its own domain terms (`HouseCatalog.findTerms`), implemented by an
   adapter that maps the other contract and its errors (anti-corruption layer).
5. **No distributed transactions.** Remote reads happen before a single local transaction;
   no remote call while a transaction is open. Invariants that cross services are
   eventually consistent.
6. **The gateway is the only public entrypoint** and contains no business logic.
7. **Services are generated** from `templates/service` and built on `@ga/service-kit`.

## Consequences

- A referenced entity can disappear after it was checked (a house deleted after a
  booking). Until ADR-0005 is implemented these cases are not reconciled.
- Request latency grows with call depth; keep fan-out shallow, parallelize independent
  calls, and denormalize via events where depth would exceed about three hops.
- Teams can change their schema freely; contracts are the only coupling.
