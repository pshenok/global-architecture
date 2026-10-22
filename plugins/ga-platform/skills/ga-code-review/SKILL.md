---

name: ga-code-review
description: Review checklist for changes in the global-architecture monorepo - layering and dependency rule, DI-safe imports, contract compatibility, error model, data integrity under concurrency, migrations, service-to-service calls, gateway API shape, tests, security and observability. Use it whenever asked to review a PR, diff, branch or a just-finished change in this repo (including your own work before declaring it done), or to check that a service follows the platform standards.
---

# Reviewing a change

Read the whole change: committed branch work with `git diff main...HEAD`, uncommitted
work (the usual case when reviewing your own change) with `git diff HEAD` plus
`git status` for new files, or the PR diff. Then walk the list. Report
findings with file:line, why it breaks in production, and the fix. Verify claims by
running the relevant command rather than guessing.

## Automated gate (must be green)

```bash
pnpm biome ci . && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm --filter @ga/contracts breaking        # any .proto change
pnpm template:verify                         # any change to templates/ or packages/
git status                                   # the gate must not leave changes behind
```

## Architecture

- [ ] Domain imports only `@ga/kernel` and domain files; application has no Drizzle, gRPC,
  contracts or `@nestjs/microservices` (Biome enforces, but check new folders).
- [ ] Business rules live in aggregates or use cases, not in controllers, repositories or the gateway.
- [ ] New external dependency = port (abstract class, domain terms) + adapter + binding in `app.module.ts`.
- [ ] No reads of another service's tables; no new call cycle between services.
- [ ] No remote call while a DB transaction is open.

## Imports and DI (silent production breakers)

- [ ] Classes injected through constructors are value imports, never `import type`.
- [ ] Interfaces/types are `import type` (else ESM link error at startup).
- [ ] No new circular imports between injectables.
- [ ] Relative imports use `.ts` specifiers.

## Contracts

- [ ] Field numbers never reused or changed; renames/removals go through deprecate -> reserve.
- [ ] Every new RPC documents its error codes; request/response wrappers per RPC.
- [ ] Regenerated code is committed and unedited.

## Errors

- [ ] Failures are `DomainError` subclasses with UPPER_SNAKE reasons; existing reasons unchanged.
- [ ] The kind matches the caller's next step (invalid input vs. wrong state vs. conflict vs. retry).
- [ ] Messages and metadata are safe for API clients (no secrets, SQL, hostnames, other users' data).
- [ ] Downstream errors are mapped in adapters (`grpcStatusOf`, `toDependencyError`), not leaked.

## Data integrity and migrations

- [ ] Uniqueness, overlaps and other concurrent invariants are DB constraints + `translateDbError`, not check-then-insert.
- [ ] Read-modify-write uses `UnitOfWork.run` + `forUpdate`.
- [ ] Migrations are generated (or custom SQL), reviewed, new files only; no edits to applied ones.
- [ ] The change is safe during a rolling deploy (expand -> migrate -> contract).
- [ ] Money in integer minor units; timestamps `timestamptz(3)`; ids from `IdGenerator`.
- [ ] List queries keyset-paginate on an indexed column and cap the page size.

## Gateway

- [ ] Every input has a Zod schema (`@Body/@Query/@Param({ schema })`) mirroring the service limits.
- [ ] Responses go through a view mapper (no raw gRPC objects); 201 + Location on create, 204 on delete.
- [ ] OpenAPI responses declared (`@ApiResponse` with `standardSchema`).

## Tests

- [ ] Domain + use-case tests for new rules; gRPC + Postgres test for each new RPC and each documented error.
- [ ] A concurrency test for each new invariant.
- [ ] Fakes keep the real adapter's contract (including its failures).

## Security and operations

- [ ] No secrets in code, config defaults, logs or error metadata; new env vars validated in `src/config.ts` and listed in `.env.example`.
- [ ] No unbounded inputs (lengths, page sizes, message sizes).
- [ ] Logs carry business events, not payloads or PII.
- [ ] Nothing assumes authentication exists (there is none yet; ADR-0004). Flag endpoints that would need it.
