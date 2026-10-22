---

name: ga-platform-maintenance
description: Maintain the global-architecture platform itself - upgrading dependency versions in the pnpm catalog under the supply-chain policy, changing the shared service kit, kernel or contracts runtime without breaking services, keeping templates/service and generated services in sync, the known sharp edges of the stack (TypeScript 7, SWC decorator metadata, ESM, Drizzle 1.0 RC, ts-proto, pnpm 12, Biome), and recording decisions as ADRs. Use it for any dependency bump, Renovate/Dependabot PR, change under packages/ or templates/, toolchain or config change (tsconfig, .swcrc, biome.json, turbo.json, pnpm-workspace.yaml), or architectural decision.
---

# Maintaining the platform

The kit, kernel, contracts runtime and template are shared by every service, so a change
there is a change to all of them. Make it once, prove it on the template, then roll it out.

## Dependency versions

Every version is in the `catalog:` of `pnpm-workspace.yaml` (`catalogMode: strict`);
`package.json` files say `"x": "catalog:"`. To upgrade:
1. Edit the catalog version. pnpm refuses versions younger than 24 h
   (`minimumReleaseAge`); wait or pin the previous patch.
2. `pnpm install`. If a new package has an install script, decide in `allowBuilds`
   (allow only what needs it; deny telemetry like `@scarf/scarf`).
3. Read the changelog for breaking changes, then run the full gate:

   ```bash
   pnpm check && pnpm build && pnpm template:verify
   pnpm stack:up && pnpm test:e2e
   ```

Upgrade framework families together (all `@nestjs/*` 12.x at once; `@grpc/grpc-js` with
`@grpc/proto-loader`). Keep the overrides for `@grpc/proto-loader` and `protobufjs`:
they guarantee a single copy (see the contracts skill for why).

## Sharp edges (each was hit and fixed once; keep them fixed)

| Area                 | Edge                                                                                           | Guard                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| TypeScript 7         | no compiler API: tools needing it (Nest CLI, Swagger CLI plugin, typescript-eslint) cannot run | SWC builds, oxlint + Biome lint, own generator                     |
| Decorators           | `import type` of an injected class -> metadata `Object` -> DI fails silently                   | Biome `useImportType` off; review checklist                        |
| ESM                  | circular imports of injectables crash at load (TDZ)                                            | no cycles; `Ref<T>` as last resort                                 |
| ESM + generated code | interfaces imported as values crash at link time                                               | `postgen.ts` rewrites to `import type`; `check-esm` in every build |
| Timestamps           | without wrappers a Date is sent as 1970-01-01                                                  | `installWellKnownTypes()` in every entrypoint                      |
| SWC target           | `es2025` unsupported by SWC 1.16                                                               | `target: es2024` in tsconfig and `.swcrc`                          |
| Vitest 5             | Vite 8 oxc emits wrong enum metadata                                                           | `unplugin-swc` in `vitest.shared.ts`                               |
| Drizzle 1.0 RC       | relational query API still changing                                                            | core query builder only; exact pin                                 |
| drizzle-kit          | `strict`/`verbose` are push-only options                                                       | not used                                                           |
| Migrations           | Drizzle's migrator takes no lock                                                               | `runMigrations` wraps it in an advisory lock                       |
| gRPC hybrid apps     | enhancers added after `connectMicroservice` are ignored                                        | services are pure microservices; filters before `listen()`         |
| Nest 12 gRPC errors  | `GrpcException` without a filter -> UNKNOWN                                                    | `GrpcErrorFilter` always registered                                |
| Fastify docs page    | raw responses skip `onSend` hooks                                                              | `/docs` CSP set by middleware                                      |
| PM2                  | `@` in the interpreter path is read as an nvm version                                          | interpreter is `node_modules/.bin/node`                            |
| pnpm 12              | npm inside the repo fails `devEngines`                                                         | use pnpm / run npm outside the repo                                |

## Changing shared code

- `packages/kernel`: pure and tiny; anything added becomes part of every domain's
  vocabulary. Never import a framework here.
- `packages/service-kit`: keep the public surface in `src/index.ts`; prefer adding options
  with safe defaults over changing behaviour. Breaking a kit API means updating every
  service in the same PR (they are all in this repo; `pnpm typecheck` lists them).
- `packages/contracts/src/runtime`: the loader options must stay in lock-step with
  `buf.gen.yaml`.
- `templates/service`: after any change run `pnpm template:verify`; then apply the same
  change to existing services (they are generated copies, not linked to the template).
  Keep `SampleItem` naming so the generator's replacements still match.

## Recording decisions

Architectural decisions go to `docs/architecture/adr/NNNN-title.md` (Nygard format:
Status, Context, Decision, Consequences). Update an ADR's status instead of rewriting
history. ADR-0001 records the stack and why each alternative was rejected.
