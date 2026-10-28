---

name: ga-platform-maintenance
description: Maintain the global-architecture platform itself - upgrading dependency versions in the pnpm catalog under the supply-chain policy (jose included), changing the shared service kit, kernel or contracts runtime without breaking services, keeping templates/service and generated services in sync, the kit's events module and the event bus, rotating workload keys and adding identity providers, the guardrails (check-access, check-call-graph, CODEOWNERS), the known sharp edges of the stack (TypeScript 7, SWC decorator metadata, ESM, Drizzle 1.0 RC, ts-proto, pnpm 12, Biome, grpc-js TLS, jose), and recording decisions as ADRs. Use it for any dependency bump, Renovate/Dependabot PR, change under packages/ or templates/, toolchain or config change (tsconfig, .swcrc, biome.json, turbo.json, pnpm-workspace.yaml), key rotation or IdP change, or architectural decision.
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
| Event payload codec  | a protobufjs copy other than proto-loader's has no well-known-type wrappers, so payload Timestamps would differ from RPCs                                                                            | `messageCodec` builds on `wellKnownProtobuf()` (proto-loader's copy, wrappers installed)                      |
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
  `buf.gen.yaml`, and `messageCodec`'s conversions (`codec.ts` `TO_OBJECT`) in lock-step
  with `GRPC_LOADER_OPTIONS`, so event payloads look exactly like RPC messages.
- `packages/service-kit/src/events` (ADR-0005): the outbox, relay and consumer are what
  every producer and consumer runs, so their rules hold for all of them:
  - always a fresh request context per relay round and per delivery
    (`cls.run({ ifNested: 'override' })`), so no user's principal or request id rides
    along, and a delivery acts only as the service itself (`enterEventDelivery` stays
    unexported);
  - never export `OutboxRelay`, `EventConsumer` or their `flush`/`pollOnce`/`process`:
    tests reach them only through `flushOutbox` and `deliverEvent` from
    `@ga/service-kit/testing`, which production code cannot import;
  - no health checks for asynchronous parts: a bus outage must not take healthy APIs out
    of rotation; lag shows in logs and `pnpm events:status`;
  - the kit's view of the tables (`tables.ts`) and the definitions in the `ga-database`
    skill change together, with a migration in every service that copied them; the boot
    check (`assertEventTables`) covers only the tables, the kit's columns and
    `processed_events`' unique key on `(subscription, event_id)`, not types, defaults or
    other indexes, so review copies against the skill;
  - one Pull carries at most 50 types (`MAX_PULL_TYPES`; `assertPullableTypes` fails boot
    for a service with more `@OnEvent` types), and the bus's `PullRequestSchema` repeats
    the 50: raise both together;
  - shutdown stays bounded: `EVENTS_DRAIN_MS` (max 14000) plus `SHUTDOWN_DELAY_MS` under
    the process manager's kill timeout.
- `apps/event-bus-service` (all of `src/` is CODEOWNERS-reviewed): the topic catalog
  (`src/domain/topics.ts`) is the ACL for event types. Storage sits behind two ports,
  `EventBroker` (delivery) and `EventBrokerAdmin` (the `events:*` commands and
  retention); the catalog rules stay above them, in `EventBusService` and
  `EventBusAdmin`. A new backend implements both ports, passes both contract suites
  (`describeEventBroker` in `test/event-broker.contract.ts`, `describeEventBrokerAdmin`
  in `test/event-broker-admin.contract.ts`) and is bound by a literal switch, never a
  computed `import()` (check-access refuses it), in `app.module.ts` and in
  `src/cli/bus.ts`, which builds its admin adapter without booting the service. What the
  CLI imports uses erasable TypeScript only (no decorators or parameter properties), so
  `node src/cli/bus.ts` runs it from source (with built workspace packages). The bus must
  call no service; `check-call-graph` enforces it at lint time and `WorkloadIdentity` at
  run time (below).
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
  Production code may not produce a value of an actor type outside the kit (see the
  script's header for the list: assertions, predicates, literals, calls and reads their
  declarations do not promise, definite fields, injected, request or callback
  parameters, overloads, ambient declarations, augmentations), use `@ts-ignore`-style
  comments or suppress the any-rules, build `x-ga-caller`/`x-ga-principal` metadata,
  reach a test helper, load a module by a computed path or `createRequire` (three
  platform files are allowed by name), use `Reflect`, or (gateway) reach the raw server,
  Nest middleware or Nest's registries outside `bootstrap.ts` and `http/openapi.ts`.
  Every production file must be a `.ts` file in a tsconfig project (`.d.ts` only in the
  kit). The script checks its own probes on every run (`apps/*/test/access-probes`: a
  line marked `// refused` must be refused, no other line); when a review finds a new
  way around a rule, add a probe line, then the rule. The API is marked unstable: after a
  TypeScript bump run `pnpm lint` and adapt the script if the API moved. Extend it when
  you add a new way to reach data
  without a user; never weaken it.
- What runs is what the tests check: `AccessPolicyCheck` (services) and `AuthRoutes`
  (gateway) record the policies at boot, per controller and handler, and the guards
  enforce that record. `startTestService` in each service's own package and
  `createTestGateway` fail when the recorded open methods or routes differ from the list
  (found from the kit's own place, never the working directory). Once Fastify is ready,
  `createTestGateway` also fails on routes, hooks, plugins, handlers or middleware added
  by code other than packages, `bootstrap.ts` and `http/openapi.ts` (attributed to the
  calling code; an unknown caller is refused); `test/harness.spec.ts` shows each case.
- Biome `noExplicitAny` and oxlint `no-unsafe-assignment/-return/-argument/-member-access/-call`
  (outside tests) keep `any` from turning request data into an actor or reaching the
  raw server.
- `tools/check-call-graph.ts` runs in `pnpm lint` after check-access and reads the same
  production code with the same TypeScript 7 checker, so aliases, namespaces and
  re-exports resolve. Every reference to the kit's `GrpcClientsModule.register` in an
  app's `src` must be a direct call with one inline array of inline objects, each with
  `target: '<workload>'` as a string literal naming a registered workload; each target is
  an edge. Definitions built elsewhere, spreads, computed keys, shorthand or accessor
  targets, `register` used as a value and `GrpcClientsModule` used other than as
  `.register(...)` fail. Any use of the kit's `EventsModule` adds an edge to
  `event-bus-service`. Outside apps' `src` both are only imported or re-exported (the
  kit's `grpc-clients.module.ts` and `events.module.ts` excepted); outside the kit and
  `tools/`, code may not build a gRPC client without the kit (Nest's `ClientProxyFactory`,
  `ClientsModule`, `ClientGrpcProxy`, `@Client`; grpc-js `Client`, `Channel`,
  `loadPackageDefinition`, `makeClientConstructor`) or reach into another app's code. In
  apps' `src` and the template no namespace import, `export *` or `import()` is allowed
  (what is read from a whole module has no name to resolve); elsewhere outside the kit and
  `tools/`, none may bind the kit, `@nestjs/microservices`, `@grpc/grpc-js`, an app's code
  or a module that exports a client builder or app code, and nowhere outside them may a
  default or named import be such a module (a CommonJS default import is the whole
  module). It fails on a cycle or any call made by the bus, and checks itself every run:
  on synthetic graphs, and on the probes in `apps/house-service/test/call-graph-probes`
  (its `package/` folder read as a package; a line marked `// refused` must be refused, no
  other line; a line marked `// edge: <workload>` must yield exactly that edge, no other
  line any). When a review finds a new way to hide a call, add a probe line, then the
  rule. TypeScript is not sound, so a deliberate structural cast can still hide a client
  from the checker; review covers that, with run-time backstops.
  `GrpcClientsModule.register` works on frozen copies of its definitions, so a client
  signs only for the target that register() validated and the checker read, whatever its
  `url()` does. The kit's `WorkloadIdentity` backs the bus rule from both ends: it signs
  no caller assertion as `event-bus-service`, and every service refuses a caller
  assertion that `event-bus-service` issued (`CALLER_INVALID`, public methods included),
  even one signed with the bus's key directly. A call without an assertion fails with
  `CALLER_MISSING`, and the bus holds only its own private key, so it cannot call a
  service whatever code it contains (health checks and reflection, which change nothing,
  answer anyone). Keep both halves and their tests (`workload-identity.spec.ts`,
  `grpc-auth.spec.ts`).
- `.github/CODEOWNERS` requires the platform owner's review for `security/`, the whole
  service kit, all of `apps/event-bus-service/src/` (it enforces the event catalog),
  `apps/gateway/src/auth/`, the gateway's `bootstrap.ts`, `main.ts`, `http/openapi.ts`
  and test harness, `packages/kernel/src/actor.ts`, `testing.ts` and `index.ts`,
  `tools/check-access.ts`, `check-call-graph.ts` and its probes
  (`apps/house-service/test/call-graph-probes/`), `lib.ts` and `verify-template.ts`, and
  everything that decides whether and how the guardrails run: package manifests,
  tsconfigs, `.swcrc`, `vitest` configs, `turbo.json`, `pnpm-workspace.yaml`, every Biome
  and oxlint config, the workflows and CODEOWNERS itself.
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
records identity and authorization; ADR-0005 records asynchronous events (its original
proposal is kept below the accepted decision).
