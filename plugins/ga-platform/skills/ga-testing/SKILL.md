---

name: ga-testing
description: Testing strategy and helpers of global-architecture - Vitest 5 with SWC, domain unit tests, use-case tests with in-memory fakes, gRPC + real Postgres integration tests via @ga/service-kit/testing (createTestDatabase, startTestService, createGrpcTestClient, grpcError), provider overrides, gateway tests with fake clients, the end-to-end suite and concurrency tests. Use it whenever you write, fix or review tests, when a change needs verification, when a test is flaky or slow, or when someone asks "how do I test this" in any service or the gateway.
---

# Testing

Layers from fast to realistic; each catches bugs the others cannot. Every service from
the template has the domain, use-case and integration layers; a service with client
adapters adds adapter tests; the gateway and the whole system have their own suites.

| Layer               | Where                                  | Runs against                                                   | Example                                     |
| ------------------- | -------------------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| Domain unit         | `src/domain/*.spec.ts`                 | nothing                                                        | `booking.spec.ts`: pricing, cancel twice    |
| Use case            | `src/application/*.spec.ts`            | in-memory fakes from `test/fakes.ts`                           | `booking.service.spec.ts`                   |
| Adapter             | `src/infrastructure/clients/*.spec.ts` | typed gRPC client faked with `vi.fn()` + `of()`/`throwError()` | house-service `grpc-user-directory.spec.ts` |
| Service integration | `test/*.spec.ts`                       | real gRPC server in-process + real Postgres schema             | `test/booking.grpc.spec.ts`                 |
| Gateway             | `apps/gateway/test/*.spec.ts`          | Fastify inject + fake gRPC clients                             | `gateway.spec.ts`                           |
| End to end          | `tests/e2e/*.e2e.spec.ts`              | the running local stack over HTTPS                             | `stack.e2e.spec.ts`                         |

```bash
pnpm --filter @ga/booking-service test                 # one package (unit + integration)
pnpm --filter @ga/booking-service exec vitest run src/domain   # just the domain
pnpm test                                              # everything (turbo, cached)
pnpm stack:up && pnpm test:e2e                         # end to end
```

Integration tests need Postgres and the `ga_test` database (`pnpm db:setup`). They use
`TEST_DATABASE_URL` (default `postgresql://ga:ga@localhost:5432/ga_test`). Turbo caches
test results; the `transit` task makes a package re-run when a workspace package it
depends on (kernel, contracts, service-kit) changes.

## Use-case tests with fakes

Construct the service directly; no Nest needed:

```ts
service = new BookingService(
  new InMemoryBookingRepository(),
  users,
  houses,
  new SequentialIds(),
  new FixedClock(),
  new PassThroughUnitOfWork(),
);
```

Fakes implement the same abstract port and the **same contract** as the real adapter,
including its failure modes (the in-memory booking repository rejects overlaps like the
exclusion constraint does). A fake that is more permissive than production hides bugs.
`SequentialIds` yields sortable UUID-shaped ids so pagination behaves like UUIDv7.
With a `FixedClock`, build dates relative to the clock (`day(30, clock.now())` from
`test/fakes.ts`), never relative to the real date, or "in the past" rules flip silently.

## Service integration tests (the most valuable layer)

```ts
db = await createTestDatabase({ migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
service = await startTestService({
  module: AppModule,
  service: SERVICE,
  // every *_SERVICE_URL in the service's config is validated at boot, even when faked
  env: { DATABASE_URL: db.url, USER_SERVICE_URL: '127.0.0.1:1', HOUSE_SERVICE_URL: '127.0.0.1:1' },
  override: (b) =>
    b.overrideProvider(UserDirectory).useValue(new FakeUserDirectory())
     .overrideProvider(HouseCatalog).useValue(new FakeHouseCatalog()),
});
client = createGrpcTestClient<BookingServiceClient>('ga.booking.v1.BookingService', SERVICE.protoFiles, service.url);
...
beforeEach(() => db.truncate('bookings'));
afterAll(async () => { client.close(); await service.close(); await db.dispose(); });
```

- `createTestDatabase` creates a private schema, runs the real migrations into it and drops
  it in `dispose()`. Parallel test files never see each other's rows.
- `startTestService` boots the real `AppModule` exactly like `main.ts` (same error filter,
  health, reflection) on a free port. Override **ports**, not adapters' internals.
- `createGrpcTestClient<XServiceClient>` gives a promise API typed by the generated client.
- `grpcError(promise)` asserts a failure and returns `{ code, message, details }` with the
  decoded `errorInfo` and `fieldViolations`:

  ```ts
  const error = await grpcError(client.createBooking(overlapping));
  expect(error.code).toBe(status.ALREADY_EXISTS);
  expect(error.details?.errorInfo?.reason).toBe('BOOKING_DATES_UNAVAILABLE');
  ```
- Dates relative to the real date (`day(30)`, the system clock is real here) keep
  "not in the past" rules green forever.
- To prove the "dependency down" path through the real adapter, start a second service
  instance without the port override and with `X_SERVICE_URL: '127.0.0.1:1'`: calls fail
  with `UNAVAILABLE` and reason `<DEP>_SERVICE_UNAVAILABLE`.

## Test what production will break on

- **Concurrency** for every invariant: fire N identical requests with `Promise.allSettled`
  and assert exactly one winner (see user-service email race, booking overlap).
- **Error contract**: assert status code and `reason` for every documented error of an RPC.
- **Pagination**: page through, check order, last page token empty, token reused with a
  different filter -> `INVALID_ARGUMENT`.
- **Partial updates**: unset fields keep their values; concurrent updates of different
  fields both survive.
- **Wire types**: timestamps come back as `Date`, money as integers, enums as strings.

## Gateway tests

Use `createTestGateway(new Map([[USER_SERVICE, fakeUsers]]))` from
`apps/gateway/test/harness.ts`: it sets every required env var (`TEST_ENV`), boots the
real gateway with the production adapter and configuration (TLS off) and returns
`inject(...)`. Write one spec per resource (`test/<resource>.spec.ts`). Fakes return
`of(response)` or `throwError(() => error)`; build gRPC errors with a `Metadata` that
carries `encodeStatusDetails(...)` to test the problem+json mapping. When the gateway
gains a downstream service, add its URL to `TEST_ENV`.

## Conventions and pitfalls

- `vi.mock` / `vi.hoisted` only at top level (Vitest 5). `clearMocks` is on by default.
- Tests import TS sources of workspace packages through the `@ga/source` condition; no
  build is needed to test.
- SWC (unplugin-swc) transforms tests so decorator metadata equals production. If DI
  suddenly fails only in tests after a tsconfig change, clear Vitest's transform cache
  (`rm -rf node_modules/.vitest-cache` at the repo root).
- Flows that need data in the past (a finished stay) cannot be produced through the
  running stack (bookings in the past are rejected); cover their happy path in the
  integration layer with fakes behind the port, and their error paths end to end.
- Never use `setTimeout`-based waits for async results; await the call.
- Never point tests at a service's real database or at the PM2 stack (except `tests/e2e`).
