---

name: ga-new-service
description: Create a new gRPC microservice in the global-architecture monorepo from the service template (generator `pnpm new:service`), then turn the SampleItem-shaped scaffold into a real domain with contract, schema, migrations, use cases, tests and registry entry. Use it whenever someone wants a new service, microservice, bounded context or "a separate service for X", or asks to split functionality out of an existing service, even if they do not say "generator" or "template".
---

# Create a new service

The template (`templates/service`) is a complete, tested service for an aggregate
called `SampleItem`. The generator copies it, renames every form of the noun
(`sample-item`, `sample_item`, `sampleItem`, `SampleItem`, `SAMPLE_ITEM`, plurals),
writes the proto contract, allocates a port, registers the service and generates the
initial migration. You then reshape the domain. Do not hand-copy an existing service:
the generator keeps every service structurally identical, which is what makes hundreds
of them maintainable.

## 0. Decide the boundary first

A service owns one business capability and its data. Before generating, write down:
- the **aggregate(s)** it owns and their invariants;
- which **other services it calls** (only "downward"; a call cycle such as A -> B -> A
  is not allowed, use events for back-references, see `ga-service-communication`);
- which **data it must not own** (e.g. booking-service stores `guest_id`, never user emails).

If the capability fits an existing service's aggregate, add an aggregate there instead
(`ga-domain-logic`).

## 1. Generate

```bash
pnpm new:service <noun>                 # e.g. review, payment-method (kebab-case, singular)
pnpm new:service person --plural people # irregular plural
pnpm new:service invoice --port 50070   # explicit port (default: next after the highest)
```

Creates:

| Output                                               | Example for `review`                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/review-service/`                               | full service, `.env` from `.env.example`                                                                         |
| `packages/contracts/proto/ga/review/v1/review.proto` | `ga.review.v1.ReviewService` (multi-word nouns use snake_case here: `ga/payment_method/v1/payment_method.proto`) |
| registry entry in `services.json`                    | port, database `ga_review`, `REVIEW_SERVICE_URL`                                                                 |
| `apps/review-service/drizzle/<ts>_init/`             | initial migration                                                                                                |

It also runs `pnpm install`, contracts codegen and `db:generate`, and formats what it
wrote with Biome. Below, `<noun>` is the kebab form (`payment-method`) and
`<noun_snake>` the snake form used by the contract (`payment_method`). Then:

```bash
pnpm db:setup                                   # creates ga_review (+ ga_test) locally
pnpm --filter @ga/review-service test           # the scaffold is green before you change it
```

## 2. Reshape, in this order

Steps 1-5 are one unit: changing the contract breaks the scaffold's controller, mapper
and tests until transport (5) and tests (7) are reshaped. Run `typecheck` after step 5 and
the tests after step 7.
1. **Contract** (`packages/contracts/proto/ga/<noun_snake>/v1/<noun_snake>.proto`): real fields,
   RPCs and doc comments listing each RPC's error codes. Then
   `pnpm --filter @ga/contracts codegen`. Follow `ga-grpc-contracts`.
2. **Domain** (`src/domain/<noun>.ts`, `<noun>.errors.ts`, `<noun>.repository.ts`): state,
   `create` / `restore` / behaviour methods, invariants throwing `ValidationError` or
   `PreconditionFailedError`, error factories with UPPER_SNAKE reasons. Follow `ga-domain-logic`.
3. **Use cases** (`src/application/<noun>.service.ts`): one method per use case, ports for
   other systems in `src/application/ports/`.
4. **Persistence** (`src/infrastructure/persistence/schema.ts` + repository): columns,
   constraints, indexes; then delete the generated `drizzle/` folder (it creates your table
   with the placeholder columns `name`/`description`) and run
   `pnpm --filter @ga/<noun>-service db:generate --name init`.
   Follow `ga-database`. Once a migration has been applied anywhere shared, never
   regenerate it; add a new one instead.
5. **Transport** (`src/transport/grpc/`): Zod request schemas, mapper, controller
   implementing the generated `XServiceController` with `@XServiceControllerMethods()`.
6. **Dependencies on other services** (if any): config vars (`grpcTarget()`),
   `GrpcClientsModule.register(...)`, adapters, bindings in `app.module.ts`, and the
   `.env`/`.env.example` entries. Follow `ga-service-communication`.
7. **Tests**: domain specs, use-case specs with fakes (`test/fakes.ts`), and the gRPC +
   Postgres spec in `test/`. Follow `ga-testing`.
8. **Docs**: the service `README.md` (purpose, RPCs, dependencies, owned tables), and the
   system views that list services: the container diagram and dependency graph in
   `docs/architecture/overview.md` and the diagram/table in the root `README.md`.
9. **Gateway exposure** (only if clients need it): `ga-gateway-endpoint`, then add the
   service URL to the gateway config and `apps/gateway/.env.example`.

Search for leftovers when done; nothing named after the placeholder may remain:

```bash
grep -rniE "sample.?item" apps/<noun>-service packages/contracts/proto/ga/<noun_snake> && echo "leftovers!"
```

## 3. Definition of done

```bash
pnpm --filter @ga/contracts lint:proto
pnpm --filter @ga/<noun>-service typecheck
pnpm --filter @ga/<noun>-service lint
pnpm --filter @ga/<noun>-service test
pnpm biome ci .
pnpm build
pnpm stack:up && pnpm test:e2e          # stack:up waits until every registered service is SERVING
git status                               # only your intended changes remain
```

`pnpm stack:up` reads `services.json`, so a registered service is started, migrated
(with the stack's `DATABASE_URL`) and health-checked over `grpc.health.v1` automatically;
it does not need its own PM2 entry. If it should be public, also add it to the gateway's
readiness targets (`ga-gateway-endpoint`).

## Things the generator cannot know

- Multiple aggregates: generate with the main noun, then add the others by hand in the
  same layered shape.
- Postgres extensions your migrations need: add `"extensions": ["btree_gist"]` to the
  service's entry in `services.json` so `pnpm db:setup` pre-creates them.
- Removing a service: first remove every consumer (other services' clients, ports and
  `*_SERVICE_URL` config; gateway routes, `clients.ts`, config, readiness target, test
  harness env), because consumer config validation fails at boot once the URL is gone.
  Then delete `apps/<noun>-service`, its proto directory and its `services.json` entry,
  regenerate contracts, update the docs listed in step 8, and drop its database when no
  environment needs it. `buf breaking` will flag the removed contract; that is expected
  for a deliberate removal.
