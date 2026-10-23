# ADR-0001: Platform stack for Node.js microservices

- Status: Accepted
- Date: 2026-10-22

## Context

`global-architecture` replaces the `nest-clean-grpc` boilerplate (see
`docs/audit/nest-clean-grpc-audit.md`) and will seed hundreds of services
written by many developers and AI coding agents. Every choice below was
verified on 2026-10-22 against the npm registry, release notes and small
experiments (NestJS 12 boot, decorator metadata under TS 7 and SWC, Drizzle
migrations against Postgres, gRPC round trips through Nest, buf codegen).

The data layer was re-checked the same day against Prisma 7.10.1, the Prisma 8
RC and Drizzle 0.45.4: hands-on runs against the booking-service schema, a
benchmark, and an independent cross-check of the findings. The benchmark ran on
a busy laptop, so absolute numbers are rough; the ratios quoted below held
across two passes and a separate serial re-run.

## Decision

| Area              | Choice                                                                                            | Why                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | Node 26 (LTS from 2026-10-28), pinned via `devEngines.runtime`                                    | Node 24 entered maintenance on 2026-10-20; 26 is supported until 2029-04. pnpm downloads the pinned Node per repo.                                        |
| Package manager   | pnpm 12 via `devEngines.packageManager`                                                           | Catalogs, `allowBuilds` allowlist, 24 h `minimumReleaseAge`, trust policy, strict unknown-setting checks.                                                 |
| Monorepo tasks    | Turborepo 2.11                                                                                    | Cached `build/typecheck/test/lint`, strict env mode, single binary.                                                                                       |
| Module format     | ESM everywhere (`"type": "module"`, `nodenext`)                                                   | NestJS 12 ships ESM-only.                                                                                                                                 |
| Framework         | NestJS 12.2                                                                                       | Structured DI and transports; gRPC for services, Fastify for the gateway.                                                                                 |
| Type checking     | TypeScript 7.0 (`tsc --noEmit`)                                                                   | Native compiler, 2-3x faster. Decorator metadata verified identical to TS 5.9 and SWC.                                                                    |
| Emit              | SWC 1.16 (legacy decorators + metadata)                                                           | Same transpiler for build, tests and dev, so no metadata drift.                                                                                           |
| Tests             | Vitest 5 + unplugin-swc                                                                           | ESM-native; SWC keeps metadata identical to the build.                                                                                                    |
| Lint / format     | Biome 2.6 (format, imports, general lint) + oxlint type-aware rules (floating promises etc.)      | Fast; typescript-eslint does not support TS 7. `useImportType` is OFF because it breaks Nest DI.                                                          |
| Service transport | gRPC via `@nestjs/microservices` + `@grpc/grpc-js` 1.14                                           | Typed contracts, deadlines, retries, native k8s probes.                                                                                                   |
| Contracts         | Protobuf in one buf module; `buf lint` STANDARD + `buf breaking` FILE; ts-proto codegen committed | One source of truth, breaking-change gate in CI.                                                                                                          |
| Edge              | HTTPS (HTTP/2 + HTTP/1.1) REST gateway on Fastify 5                                               | REST for clients, gRPC inside.                                                                                                                            |
| Validation        | Zod 4 (Standard Schema)                                                                           | One schema system for env, gRPC requests and REST DTOs.                                                                                                   |
| Data              | PostgreSQL, database per service, Drizzle ORM 1.0 (RC, exact pin), node-postgres                  | TS schema is the source of truth, SQL migrations reviewed in PRs, close to raw `pg` speed, non-interactive migration generation that works for AI agents. |
| Transactions      | `nestjs-cls` + `@nestjs-cls/transactional` behind a `UnitOfWork` port                             | Application layer stays ORM-free.                                                                                                                         |
| Identity          | OIDC access tokens at the gateway (jose 6), Ed25519 workload keys, gRPC TLS (ADR-0004)            | One login check at the edge; every hop proves who calls and for which user, without a mesh or an IdP in the services.                                     |
| IDs               | UUIDv7 generated in the application                                                               | Time-ordered, keyset-pagination friendly, known before insert.                                                                                            |
| Logging           | pino 10 + nestjs-pino, request id in AsyncLocalStorage and gRPC metadata                          | Structured JSON, correlation across hops.                                                                                                                 |
| Tracing           | OpenTelemetry SDK, off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set                                | Zero cost by default.                                                                                                                                     |
| Local runtime     | PM2 for processes, local or Docker Postgres                                                       | No infrastructure needed to run the whole system.                                                                                                         |

## Rejected alternatives

- **Prisma 7.10**: the v7 line is in maintenance mode (fixes are promised for 18 months after Prisma 8 GA), and the next major is a rewrite (below). Findings on our stack: when the Postgres session `TimeZone` is not UTC, `@prisma/adapter-pg` silently shifts `timestamptz` values (Prisma reads its own writes back unchanged, so Prisma-only tests miss it; `-c TimeZone=UTC` on the pool fixes it). Exclusion and check violations surface as a generic P2039 without the constraint name, so `translateDbError` cannot map `bookings_no_overlap` without parsing the message text. It uses about 2x the CPU per operation of Drizzle 1.0 RC and reached 43-53% of raw `pg` throughput against 81-97%. Migrations can be generated without a human (`migrate dev --create-only --name <change>`, then `migrate deploy`), but `migrate dev` without `--name` hangs when there is neither a TTY nor a `CI` variable. Since 7.10.0 the `prisma` CLI package is published without npm provenance; `@prisma/client` and `@prisma/adapter-pg` still have it.
- **Prisma 8 (RC)**: a plain `npm install prisma` has installed it since 2026-08-25, but it is a different ORM (a contract file instead of PrismaClient; no `generate` or `migrate dev`). 26 RCs in two months with breaking changes in most of them, no GA date, and 13 `npm audit` findings in its dependency tree.
- **Drizzle 0.45 (stable)**: guaranteed breaking upgrade to 1.0, no node-postgres transaction fixes from 1.0 RC, and 45-58% of raw `pg` throughput. We use only the core query builder, which is the part least affected by remaining RC changes. Fallback if RC churn hurts, rehearsed on 2026-10-22: pin `drizzle-orm@0.45.4` and `drizzle-kit@0.31`. The source compiles and all tests pass unchanged, but each migrations folder must first be converted to the `meta/_journal.json` layout; otherwise kit 0.31 silently generates a full baseline that omits hand-written SQL such as the exclusion constraint. Kit 0.31 also skips an ambiguous rename without a TTY (exit 0, no file written), and a database migrated by 0.45 needs a manual fix before returning to 1.0, because 0.45 records applied migrations without names and the 1.0 migrator applies them again.
- **Connect-RPC**: no first-party Nest integration, bypasses Nest guards/pipes/filters, needs a second codegen. Revisit for browser-facing APIs.
- **ESLint + typescript-eslint**: no TypeScript 7 support.
- **Jest**: needs experimental VM modules for ESM Nest; slower.
- **tsx / esbuild runners**: do not emit decorator metadata, so Nest DI breaks.
- **Nx**: heavier, its boundary rules depend on typescript-eslint.

## Consequences

- Drizzle is pinned to an exact RC; upgrades are deliberate and go through the template first. 1.0 has no GA date and formats still change inside the RC line (rc.5 moved migration snapshots from version 8 to 9).
- Open issue drizzle-team/drizzle-orm#6572 (Prisma 7 behaves the same): when a statement fails inside a transaction and the callback swallows the error, Postgres answers COMMIT with ROLLBACK, yet the transaction resolves as success and its writes are silently lost. Code inside `UnitOfWork.run` never catches a database error and carries on; it translates and rethrows, as the repositories do.
- TypeScript 7 has no compiler API yet, so tools that need it (Nest CLI schematics, Swagger CLI plugin) are not used. Our own generator replaces `nest g`.
- Known sharp edges are encoded in code and docs: injectable classes must stay value imports, ESM circular imports need `Ref<T>`, proto timestamps need the installed well-known-type wrappers, and `@grpc/proto-loader` / `protobufjs` are pinned to single versions via pnpm overrides.
