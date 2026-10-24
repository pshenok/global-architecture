---

name: ga-code-review
description: Review checklist for changes in the global-architecture monorepo - layering and dependency rule, DI-safe imports, contract compatibility, access control (@Access policies, via lists, actors, NOT_FOUND vs PERMISSION_DENIED, scoped lists, public endpoints), error model, data integrity under concurrency, migrations, service-to-service calls, asynchronous events (outbox, handlers, catalog, payloads), gateway API shape, tests, security and observability. Use it whenever asked to review a PR, diff, branch or a just-finished change in this repo (including your own work before declaring it done), or to check that a service follows the platform standards.
---

# Reviewing a change

Read the whole change: committed branch work with `git diff main...HEAD`, uncommitted
work (the usual case when reviewing your own change) with `git diff HEAD` plus
`git status` for new files, or the PR diff. Then walk the list. Report
findings with file:line, why it breaks in production, and the fix. Verify claims by
running the relevant command rather than guessing.

## Automated gate (must be green)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # lint = biome ci + check-access + check-call-graph + oxlint
pnpm --filter @ga/contracts breaking        # any .proto change
pnpm template:verify                         # any change to templates/ or packages/
git status                                   # the gate must not leave changes behind
```

## Architecture

- [ ] Domain imports only `@ga/kernel` and domain files; application has no Drizzle, gRPC,
  contracts or `@nestjs/microservices` (Biome enforces, but check new folders).
- [ ] Business rules live in aggregates or use cases, not in controllers, repositories or the gateway.
- [ ] New external dependency = port (abstract class, domain terms) + adapter + binding in `app.module.ts`.
- [ ] No reads of another service's tables; no new call cycle between services
  (`check-call-graph` reads every client `target`; it must stay a string literal).
- [ ] No remote call while a DB transaction is open (the kit refuses it at run time with
  `RemoteCallInTransactionError`; the review catches it before a test does).
- [ ] A reaction to what happened in another service is an event, not a new call.

## Imports and DI (silent production breakers)

- [ ] Classes injected through constructors are value imports, never `import type`.
- [ ] Interfaces/types are `import type` (else ESM link error at startup).
- [ ] No new circular imports between injectables.
- [ ] Relative imports use `.ts` specifiers.

## Contracts

- [ ] Field numbers never reused or changed; renames/removals go through deprecate -> reserve.
- [ ] Every new RPC documents its `// Access:` policy and its error codes (including
  UNAUTHENTICATED and, where it applies, PERMISSION_DENIED); request/response wrappers per RPC.
- [ ] No request field carries the acting user (`owner_id`, `guest_id` of the caller).
- [ ] Regenerated code is committed and unedited.

## Access (ADR-0004)

- [ ] Every new gRPC method has exactly one `@Access`, the narrowest that works: `user`
  over `public`, `admin` for admin-only, `identity` only for registration and resolution.
- [ ] Every `via` entry is justified: the listed service really calls this method on the
  user's behalf, and the change is acceptable to the callee's owners (that service can
  act as any user whose request passes through it). `@Access.service([...])` lists only
  the workloads that need it.
- [ ] The acting user never comes from a request (body, query, path, proto field):
  controllers pass `currentUser()` as the use case's first argument, and new resources
  take their owner from the actor.
- [ ] Rules live in the domain (`isVisibleTo`, `assertManageableBy`, scope functions);
  writes check them under the row lock.
- [ ] A resource the caller may not know about answers `NOT_FOUND` with the same reason and
  message as a missing one; `PERMISSION_DENIED` only for visible resources and roles.
- [ ] Lists of private data take a typed scope in the repository; page tokens are bound to
  the caller and the scope.
- [ ] Anything that does not need a signed-in user (`@Access.public`, `@Public`,
  `@AllowUnregistered`, `@Access.identity`, `@Access.service`) is listed in
  `security/public-endpoints.json` with a real reason; the change goes to the code owners.
  Decorators are written directly on the method or class with inline literal arguments;
  `check-access` fails any other use of them or their metadata, and the tests compare the
  list with the policies the guards enforce.
- [ ] Tests cover the access matrix: the five template cases per resource, each role and
  owner rule, allowed and refused forwarders.
- [ ] No actor made outside the kit: `check-access` (type-aware) fails assertions and
  type predicates to types that are or hold an actor, `never` or type parameters; actor
  literals; calls and property reads that return an actor their declaration does not
  promise; definitely-assigned actor fields; actors from constructor injection, request
  parameters or typed callbacks; overloads, ambient declarations and augmentations.
  Biome and oxlint refuse `any`; `@ts-ignore`-style comments fail. No hand-built `x-ga-*`
  metadata, no test helpers in production code, and no new way around the guard or TLS.
  TypeScript is unsound: if you see a new way to get an actor past the checker, add it
  to `apps/*/test/access-probes` with a rule. Code that defeats types at run time
  (`eval`) and edits to the guardrails are yours to refuse.

## Events (ADR-0005)

- [ ] Events are recorded through a domain-named port whose adapter calls `Outbox.add`,
  inside the same `UnitOfWork.run` as the change; a use case never publishes directly or
  talks to the bus or a queue.
- [ ] Handlers are `@OnEvent` methods in `src/transport/events`, one per type, calling one
  use case with `currentService()`; no actor parameter, no remote call, no business logic.
- [ ] Each handler is idempotent and commutative: it filters by state ("still CONFIRMED",
  "still exists") and works whatever arrives first; a redelivery changes nothing.
- [ ] Use cases only workloads may run take `ServiceActor` first and are exposed by no controller.
- [ ] Payloads carry domain facts and ids only: no personal data, no principal, nothing
  that belongs in the envelope (event id, time, request id).
- [ ] Event names follow `ga.<domain>.v<N>.<Aggregate><PastFact>Event` in
  `<domain>_events.proto`; changes are additive, an incompatible one is a new `v2` type.
- [ ] A new type, producer or subscriber always edits the catalog entry in
  `apps/event-bus-service/src/domain/topics.ts`. The bus controller's `@Access.service`
  lists and `security/public-endpoints.json` change only when a workload joins or leaves
  the bus (a bus test fails while the three disagree). The producer's descriptor names
  the owner the catalog names.
- [ ] A service handles at most 50 event types: one Pull carries at most 50, and the kit
  fails boot with more.
- [ ] Tests: the producer's outbox after the RPC (and nothing after a refused call); the
  consumer's effect, a duplicate delivery and an unexpected producer (`deliverEvent`).

## Errors

- [ ] Failures are `DomainError` subclasses with UPPER_SNAKE reasons; existing reasons unchanged.
- [ ] The kind matches the caller's next step (invalid input vs. wrong state vs. conflict vs. retry).
- [ ] Messages and metadata are safe for API clients (no secrets, SQL, hostnames, other users' data).
- [ ] Downstream errors are mapped in adapters (`grpcStatusOf`, `toDependencyError`), not leaked;
  downstream UNAUTHENTICATED and platform PERMISSION_DENIED are rethrown as bugs, not turned into 401/403.

## Data integrity and migrations

- [ ] Uniqueness, overlaps and other concurrent invariants are DB constraints + `translateDbError`, not check-then-insert.
- [ ] Read-modify-write uses `UnitOfWork.run` + `forUpdate`.
- [ ] Migrations are generated (or custom SQL), reviewed, new files only; no edits to applied ones.
- [ ] The change is safe during a rolling deploy (expand -> migrate -> contract); a NOT NULL
  column on a populated table goes expand -> backfill -> contract.
- [ ] Money in integer minor units; timestamps `timestamptz(3)`; ids from `IdGenerator`.
- [ ] List queries keyset-paginate on an indexed column and cap the page size.

## Gateway

- [ ] Every input has a Zod schema (`@Body/@Query/@Param({ schema })`) mirroring the service limits.
- [ ] Routes need a registered user unless `@Public(reason)` (or `@AllowUnregistered()` for
  registration); no owner, guest or user ids in bodies (`me` for the signed-in user).
- [ ] Responses go through a view mapper (no raw gRPC objects); 201 + Location on create, 204 on delete.
- [ ] OpenAPI responses declared (`@ApiResponse` with `standardSchema`); 401/403 come automatically.

## Tests

- [ ] Domain + use-case tests for new rules; gRPC + Postgres test for each new RPC and each documented error.
- [ ] A concurrency test for each new invariant.
- [ ] Fakes keep the real adapter's contract (including its failures and scopes).
- [ ] Lists of failing calls are built as thunks (`async () => client.x(...)`).

## Security and operations

- [ ] No secrets in code, config defaults, logs or error metadata; new env vars validated in `src/config.ts` and listed in `.env.example`.
- [ ] No tokens, keys or `authorization` headers in logs, messages or metadata; no IdP role
  or unverified email trusted beyond the issuer's email policy.
- [ ] No unbounded inputs (lengths, page sizes, message sizes).
- [ ] Logs carry business events, not payloads or PII.
