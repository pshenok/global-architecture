---

name: ga-platform-maintenance
description: Maintain the global-architecture platform itself - upgrading dependency versions in the pnpm catalog under the supply-chain policy (jose included), changing the shared service kit, kernel or contracts runtime without breaking services, keeping templates/service and generated services in sync, rotating workload keys and adding identity providers, the access guardrails (check-access, CODEOWNERS), the known sharp edges of the stack (TypeScript 7, SWC decorator metadata, ESM, Drizzle 1.0 RC, ts-proto, pnpm 12, Biome, grpc-js TLS, jose), and recording decisions as ADRs. Use it for any dependency bump, Renovate/Dependabot PR, change under packages/ or templates/, toolchain or config change (tsconfig, .swcrc, biome.json, turbo.json, pnpm-workspace.yaml), key rotation or IdP change, or architectural decision.
---

# Maintaining the platform

The kit, kernel, contracts runtime and template are shared by every service, so a change
there is a change to all of them. Make it once, prove it on the template, then roll it out.

## Dependency versions

Every version is in the `catalog:` of `pnpm-workspace.yaml` (`catalogMode: strict`);
`package.json` files say `"x": "catalog:"`. To upgrade:
1. Edit the catalog version. pnpm refuses versions younger than 24 h
   (`minimumReleaseAge`); wait or pin the previous patch. `@grpc/proto-loader` and
   `protobufjs` are pinned twice (catalog and `overrides`); bump both or nothing changes.
   Node and pnpm are not in the catalog: they are pinned in `package.json`
   (`devEngines`, `engines`), `.github/workflows/ci.yml` and every `Dockerfile`.
2. `pnpm install`. If a new package has an install script, decide in `allowBuilds`
   (allow only what needs it; deny telemetry like `@scarf/scarf`).
3. Read the changelog for breaking changes, then run the full gate:

   ```bash
   pnpm check && pnpm build && pnpm template:verify
   pnpm --filter @ga/contracts codegen && git diff --exit-code packages/contracts   # codegen stable
   pnpm --filter @ga/contracts lint:proto
   pnpm stack:up && pnpm test:e2e
   git status                                  # the gate must leave the tree clean
   ```

Upgrade framework families together (all `@nestjs/*` 12.x at once; `@grpc/grpc-js` with
`@grpc/proto-loader`). Keep the overrides for `@grpc/proto-loader` and `protobufjs`:
they guarantee a single copy (see the contracts skill for why).

`jose` does every JWS signature and verification: the kit's caller and principal tokens,
the gateway's access tokens and IdP keys, the dev tools. Declare it (`"jose": "catalog:"`)
in each package that imports it, upgrade it on its own, read its changelog for changes in
verification (algorithms, claim checks, key handling), and run the auth suites:
`packages/service-kit/src/auth/*.spec.ts`, `apps/gateway/test/auth.spec.ts` and
`tests/e2e/access.e2e.spec.ts`.

## Sharp edges (each was hit and fixed once; keep them fixed)

| Area                 | Edge                                                                                                                                                                                                 | Guard                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| TypeScript 7         | no compiler API: tools needing it (Nest CLI, Swagger CLI plugin, typescript-eslint) cannot run                                                                                                       | SWC builds, oxlint + Biome lint, own generator                                                                |
| Decorators           | `import type` of an injected class -> metadata `Object` -> Nest fails at boot with `UnknownDependenciesException` (it hints at `import type`); tests that construct classes directly do not catch it | Biome `useImportType` off; review checklist                                                                   |
| ESM                  | circular imports of injectables crash at load (TDZ)                                                                                                                                                  | no cycles; `Ref<T>` as last resort                                                                            |
| ESM + generated code | interfaces imported as values crash at link time                                                                                                                                                     | `postgen.ts` rewrites to `import type`; `check-esm` in every build                                            |
| Timestamps           | without wrappers a Date is sent as 1970-01-01                                                                                                                                                        | `installWellKnownTypes()` in every entrypoint                                                                 |
| SWC target           | `es2025` unsupported by SWC 1.16                                                                                                                                                                     | `target: es2024` in tsconfig and `.swcrc`                                                                     |
| Vitest 5             | Vite 8 oxc emits wrong enum metadata                                                                                                                                                                 | `unplugin-swc` in `vitest.shared.ts`                                                                          |
| Drizzle 1.0 RC       | relational query API still changing                                                                                                                                                                  | core query builder only; exact pin                                                                            |
| drizzle-kit          | `strict`/`verbose` are push-only options                                                                                                                                                             | not used                                                                                                      |
| Migrations           | Drizzle's migrator takes no lock                                                                                                                                                                     | `runMigrations` wraps it in an advisory lock                                                                  |
| gRPC hybrid apps     | enhancers added after `connectMicroservice` are ignored                                                                                                                                              | services are pure microservices; filters before `listen()`                                                    |
| Nest 12 gRPC errors  | `GrpcException` without a filter -> UNKNOWN                                                                                                                                                          | `GrpcErrorFilter` always registered                                                                           |
| Nest guards and CLS  | guards run before the CLS interceptor, so the auth guard cannot write the request context                                                                                                            | the guard keys the verified call on the call's `Metadata`; the CLS `setup` copies it (`principal-context.ts`) |
| grpc-js TLS          | grpc-js sends the target host as the TLS server name, and Node refuses an IP address there                                                                                                           | targets are host names (`localhost:50051`); `channelCredentials` refuses IP targets when a CA is set          |
| jose remote JWKS     | `createRemoteJWKSet` reloads on the request path and fails requests while the IdP is down                                                                                                            | `IdpKeySet`: background refresh, last good keys, 503 after `AUTH_JWKS_MAX_STALE_S`                            |
| Fastify docs page    | raw responses skip `onSend` hooks                                                                                                                                                                    | `/docs` CSP set by middleware                                                                                 |
| PM2                  | `@` in the interpreter path is read as an nvm version                                                                                                                                                | interpreter is `node_modules/.bin/node`                                                                       |
| pnpm 12              | npm inside the repo fails `devEngines`                                                                                                                                                               | use pnpm / run npm outside the repo                                                                           |

## Changing shared code

- `packages/kernel`: pure and tiny; anything added becomes part of every domain's
  vocabulary. Never import a framework here.
- `packages/service-kit`: keep the public surface in `src/index.ts`; prefer adding options
  with safe defaults over changing behaviour. Breaking a kit API means updating every
  service in the same PR (they are all in this repo; `pnpm typecheck` lists them). The raw
  token functions (`signCallerToken`, `signPrincipalToken`, `readSigningKey`) are exported
  only from `@ga/service-kit/testing`, for tests and local tools.
- `packages/contracts/src/runtime`: the loader options must stay in lock-step with
  `buf.gen.yaml`.
- `templates/service`: after any change run `pnpm template:verify`; then apply the same
  change to existing services (they are generated copies, not linked to the template).
  Keep `SampleItem` naming so the generator's replacements still match, keep the five
  access tests, and keep the two literal anchors the generator rewrites:
  `GRPC_PORT=50099` in `.env.example` and `EXPOSE 50051` in the `Dockerfile`
  (`tools/new-service.ts`).

## Access guardrails

- `tools/check-access.ts` runs in `pnpm lint` (and in `pnpm template:verify` on a
  generated service). It reads the code with the TypeScript 7 checker
  (`typescript/unstable/sync`, which spawns the bundled `tsgo`), so it resolves imports,
  renames, namespaces and aliases. Every `@Access.public`, `@Public`,
  `@AllowUnregistered`, `@Access.identity` and `@Access.service` must match an entry
  (`file#Class.method` or `file#Class`, access, reason) in
  `security/public-endpoints.json`; the decorators may appear only as decorators on a
  method or class with inline literal arguments, and their metadata not at all.
  Production code may not produce a value of an actor type outside the kit (assertions,
  type predicates, `never`, type parameters, spreads, library copies, overloads, ambient
  declarations), build `x-ga-caller`/`x-ga-principal` metadata, reach a test helper, load
  a module by a computed path (three platform files are allowed by name), or (gateway)
  add routes or middleware outside controllers. Every production file must belong to a
  tsconfig project. The API is marked unstable: after a TypeScript bump run `pnpm lint`
  and adapt the script if the API moved. Extend it when you add a new way to reach data
  without a user; never weaken it.
- What runs is what the tests check: `AccessPolicyCheck` (services) and `AuthRoutes`
  (gateway) record the policies at boot and the guards enforce that record.
  `startTestService` in each service's own package and `createTestGateway` fail when the
  recorded open methods or routes differ from the list (found from the kit's own place,
  never the working directory); `createTestGateway` also fails on routes no controller
  serves and on middleware other than logging and the request context.
- Biome `noExplicitAny` and oxlint `no-unsafe-assignment/-return/-argument` (outside
  tests) keep `any` from turning request data into an actor.
- `.github/CODEOWNERS` requires the platform owner's review for `security/`, the kit's
  `auth/`, `grpc/`, `platform/` and `testing/` code, `apps/gateway/src/auth/` and the
  gateway test harness, `packages/kernel/src/actor.ts`, `testing.ts` and `index.ts`,
  `tools/check-access.ts`, `lib.ts` and `verify-template.ts`, and everything that decides
  whether the guardrails run: root and package `package.json` and `vitest` configs,
  `turbo.json`, `pnpm-workspace.yaml`, the Biome and oxlint configs, the workflows and
  CODEOWNERS itself.
- Never add a switch that disables authentication or allows plaintext gRPC off loopback;
  ADR-0004 rejects both, because agents would use them.

## Keys and identity providers

**Workload keys.** Each workload signs with its own Ed25519 key (`WORKLOAD_KEY_FILE`, a
secret mounted into that workload only) and trusts one public key map
(`WORKLOAD_KEYS_FILE`, not secret, at most 5 keys per workload), which every workload
re-reads every `WORKLOAD_KEYS_RELOAD_S` (60 s; a broken file keeps the last good map).
Rotate in this order:
1. Add the new public key to the map and roll out the map.
2. Wait until every workload has reloaded it: each logs `workload keys reloaded; trusts ...`
   (within 60 s after the file changes).
3. Replace the workload's private key file (`WORKLOAD_KEY_FILE`). It switches on its next
   reload, without a restart, and logs `now signs with key <kid>`. A key whose public half
   is not in the workload's own map yet is not used (an error is logged every reload),
   and a workload refuses to boot with one. That check sees only the signer's copy of the
   map, not the others': once the map reaches it, it switches on its own next reload, and
   workloads that have not reloaded the map yet refuse its calls until they do (up to
   60 s, plus however long the file takes to reach each pod). So never skip step 2, and
   never change the map and the private key in one rollout.
4. 120 s after that log line (the longest token lifetime), remove the old public key. A
   workload whose own signing key disappears from the map logs an error every reload.

On compromise, remove the leaked public key at once (its tokens fail once each workload
reloads the map) and publish and switch to a new private key; calls signed with the old
key fail in between. Locally, `pnpm keys --rotate <name>` does steps 1 to 3, and later
`pnpm keys --prune <name>` does step 4 (it refuses within 130 s of the switch).

**IdP keys rotate by themselves.** The gateway refreshes each provider's JWKS in the
background (`AUTH_JWKS_REFRESH_S`, 300 s; within seconds after a failed fetch), fetches
early for a token with an unknown `kid` (at most once per
`AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S`, 30 s; a 503, not a 401, while fetches fail), and stops
using keys it could not refresh for `AUTH_JWKS_MAX_STALE_S` (30 min, at least twice the
refresh interval; then 503, never 401). Requests never start a fetch while keys are unusable.

**Adding or changing an identity provider** is configuration: an entry in `AUTH_ISSUERS`
(one to five issuers, so a migration can trust two at once; asymmetric algorithms only;
https except loopback outside production). See `docs/architecture/identity-providers.md`.
Moving users to a new provider means inserting `user_identities` rows in user-service
before the gateway trusts the new issuer (otherwise early logins register second
accounts), never linking logins by email; platform roles stay in user-service.

## Recording decisions

Architectural decisions go to `docs/architecture/adr/NNNN-title.md` (Nygard format:
Status, Context, Decision, Consequences). Update an ADR's status instead of rewriting
history. ADR-0001 records the stack and why each alternative was rejected; ADR-0004
records identity and authorization.
