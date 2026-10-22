# Audit: `pshenok/nest-clean-grpc` (commit `b491ad6`)

Audited on 2026-10-22 as the starting point for `global-architecture`.
Method: full read of every file, plus an empirical run of the service
(Node 22, Postgres 17, original dependency ranges) with a raw `@grpc/grpc-js`
client probing each RPC. "Verified" below means the behaviour was reproduced,
not inferred.

## Verdict

The codebase is a reasonable _sketch_ of layered NestJS, but it does not work as a
gRPC service, and its toolchain is 1–2 majors behind on almost every axis. It is
cheaper and safer to rebuild than to patch. `global-architecture` keeps its good
ideas (domain / infra / transport split, repository ports, Prisma, gRPC-first
services, REST only at the edge) and replaces the rest.

## Critical defects (verified by running it)

| #   | Defect                                                                                                                                                                                                                                   | Evidence                                                                                                                                                                      | Impact                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| C1  | **Every business RPC returns `UNIMPLEMENTED`.** `UserGrpcService` / `HealthGrpcService` are registered as `providers`, but Nest only binds `@GrpcMethod` handlers declared on `controllers`.                                             | `src/grpc/grpc.module.ts:18-20`. Probe: `CreateUser`, `GetUser`, `GetUsers` → code 12 `The server does not implement the method …`. No `Mapped … gRPC` lines in the boot log. | The README's "all business functionality is available via gRPC" is false; only REST `/api/health` works.         |
| C2  | **All domain errors reach clients as `UNKNOWN / "Internal server error"`.** The domain throws HTTP exceptions (`NotFoundException`, `ConflictException`); the gRPC exception interceptor that should translate them never runs (see C3). | Probe after fixing C1: duplicate email → code 2, missing id → code 2, malformed UUID → code 2.                                                                                | Callers cannot distinguish not-found, conflict, bad input or a real outage; retries and UX logic are impossible. |
| C3  | **Global interceptors are not applied to the gRPC server.** `useGlobalInterceptors` is called on the HTTP app; a hybrid app does not inherit global enhancers unless `connectMicroservice(..., { inheritAppConfig: true })`.             | `src/main-hybrid.ts:46-52`, `src/main-grpc.ts:21-27`. Probe: 0 `gRPC Request` log lines across 5 calls.                                                                       | No request logging, no error mapping for gRPC.                                                                   |
| C4  | **`docker-compose up` starts an app with no tables.** There is no `prisma/migrations` directory, so `prisma migrate deploy` applies nothing.                                                                                             | `npx prisma migrate deploy` → "No pending migrations"; only `_prisma_migrations` exists afterwards.                                                                           | Every RPC would fail at runtime in the Docker path.                                                              |
| C5  | **Docker build cannot succeed.** The repo ships `pnpm-lock.yaml`, the Dockerfile runs `npm ci` (requires `package-lock.json`) and the deprecated `--only=production`.                                                                    | `Dockerfile:11,34`; no `package-lock.json` in the repo.                                                                                                                       | Image cannot be built.                                                                                           |
| C6  | **Proto codegen script is broken and its output unused.** `npx ts-proto` is not a CLI (ts-proto is a `protoc` plugin; `protoc` is not installed or invoked). All handlers are typed `any`.                                               | `scripts/generate-protos.sh:10-21`, `src/grpc/services/*.ts`.                                                                                                                 | Zero compile-time contract safety between proto and code.                                                        |

## High-severity design issues

| #   | Issue                                                                                                                                                                                    | Evidence                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| H1  | Domain layer depends on `@nestjs/common` HTTP exceptions, violating the dependency rule (domain must not know about transports).                                                         | `src/domain/user/user.service.ts:1,17,29,40`                                  |
| H2  | Check-then-insert race on unique email: two concurrent `CreateUser` calls both pass `findByEmail`, the loser hits a Prisma `P2002` that is not mapped. Same for update/delete (`P2025`). | `user.service.ts:27,38`, `user.repository.ts`                                 |
| H3  | Exception interceptor would leak stack traces to clients (`details: error.stack`).                                                                                                       | `src/grpc/interceptors/grpc-exception.interceptor.ts:22`                      |
| H4  | Unbounded page size (`take` accepted as 1,000,000) and 100 MB max gRPC message size: trivial memory DoS.                                                                                 | `user.grpc.service.ts:35`, `grpc.options.ts:20-21`; probe `take=1e6` accepted |
| H5  | Prisma logs every SQL query (including PII such as emails) in every environment.                                                                                                         | `database.service.ts:8`; 7 `prisma:query` lines for 5 calls                   |
| H6  | No graceful shutdown: no `enableShutdownHooks`, so SIGTERM drops in-flight RPCs and never disconnects Prisma.                                                                            | grep: no `enableShutdownHooks` in `src/`                                      |
| H7  | Non-standard health service (`health.HealthService`) instead of `grpc.health.v1.Health`, so Kubernetes gRPC probes and `grpc_health_probe` cannot use it; DB health uses `as any` casts. | `protos/health.proto`, `health.grpc.service.ts:21,28`                         |
| H8  | The production `AppModule` registers gRPC _clients_ to itself "for testing".                                                                                                             | `src/app.module.ts:23`                                                        |
| H9  | Type safety disabled: `strictNullChecks: false`, `noImplicitAny: false`.                                                                                                                 | `tsconfig.json:15-16`                                                         |

## Medium / hygiene

- Proto design: unversioned packages (`user` instead of `ga.user.v1`), camelCase field names (proto style is snake_case), timestamps as strings instead of `google.protobuf.Timestamp`, a custom `Empty`, `DeleteUserResponse { success }` instead of `google.protobuf.Empty`, no lint or breaking-change checks.
- Logger: `log4js` + `cls-hooked` (unmaintained, `async_hooks`-based); a CLS namespace is created and never used; `lodash` imported and unused.
- Config: two `ConfigModule.forRoot()` calls; env read at class-field init with no schema validation.
- Repository returns Prisma rows typed as domain entities (no mapping boundary).
- Three copy-pasted bootstrap files (`main.ts`, `main-grpc.ts`, `main-hybrid.ts`).
- `nest-cli.json` asset glob points at `grpc/protos/*.proto`, which does not exist; protos only resolve by accident via `__dirname/../../protos`.
- Swagger, class-validator, class-transformer and swagger-ui-express are shipped for a single health endpoint.
- Tests: no unit tests at all; one e2e test that needs a live database.
- `docker-compose.yml` uses the obsolete `version` key and inline credentials.

## Outdated toolchain (as of 2026-10-22)

| Area         | Was                               | Now available                                |
| ------------ | --------------------------------- | -------------------------------------------- |
| Runtime      | Node 18 (EOL 2025-04)             | Node 24 LTS, Node 26 current                 |
| Framework    | NestJS 11 (CommonJS)              | NestJS 12 (ESM)                              |
| TypeScript   | 5.8, non-strict                   | 7.0 (native compiler)                        |
| ORM          | Prisma 6 (Rust engine)            | Prisma 7 (Rust-free client, driver adapters) |
| Tests        | Jest 29 + ts-jest                 | Vitest 5                                     |
| Lint/format  | ESLint 8 legacy config + Prettier | Biome 2 / ESLint 10 flat config              |
| Logging      | log4js + cls-hooked               | pino 10 + AsyncLocalStorage                  |
| gRPC codegen | broken script                     | buf CLI + ts-proto                           |

The replacement stack and the reasoning behind every choice are recorded in
`docs/architecture/adr/`.
