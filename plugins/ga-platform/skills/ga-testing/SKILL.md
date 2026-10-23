---

name: ga-testing
description: Testing strategy and helpers of global-architecture - Vitest 5 with SWC, domain unit tests, use-case tests with in-memory fakes and test actors (@ga/kernel/testing), gRPC + real Postgres integration tests via @ga/service-kit/testing (createTestDatabase, startTestService with as/asIdentity/asService/anonymous/callers/keys, createGrpcTestClient, grpcError), the five mandatory access tests, provider overrides, gateway tests with a test identity provider and fake clients, the end-to-end suite and concurrency tests. Use it whenever you write, fix or review tests, when a change needs verification, when a test is flaky or slow, when a test fails with UNAUTHENTICATED or PERMISSION_DENIED, or when someone asks "how do I test this" in any service or the gateway.
---

# Testing

Layers from fast to realistic; each catches bugs the others cannot. Every service from
the template has the domain, use-case and integration layers; a service with client
adapters adds adapter tests; the gateway and the whole system have their own suites.

| Layer               | Where                                  | Runs against                                                             | Example                                                           |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Domain unit         | `src/domain/*.spec.ts`                 | nothing                                                                  | `booking.spec.ts`: pricing, cancel twice; `booking-scope.spec.ts` |
| Use case            | `src/application/*.spec.ts`            | in-memory fakes from `test/fakes.ts`, test actors                        | `booking.service.spec.ts`                                         |
| Adapter             | `src/infrastructure/clients/*.spec.ts` | typed gRPC client faked with `vi.fn()` + `of()`/`throwError()`           | house-service `grpc-user-directory.spec.ts`                       |
| Service integration | `test/*.spec.ts`                       | real gRPC server in-process (auth guard included) + real Postgres schema | `test/booking.grpc.spec.ts`                                       |
| Gateway             | `apps/gateway/test/*.spec.ts`          | Fastify inject + test identity provider + fake gRPC clients              | `gateway.spec.ts`, `auth.spec.ts`                                 |
| End to end          | `tests/e2e/*.e2e.spec.ts`              | the running local stack over HTTPS (and gRPC over TLS)                   | `stack.e2e.spec.ts`, `access.e2e.spec.ts`                         |

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

Construct the service directly; no Nest needed. Actors come from `@ga/kernel/testing`
(`userActor(id, roles?)`, `adminActor(id)`, `identityActor(issuer, subject, email?)`,
`serviceActor(name)`), the only way to build one outside the service kit:

```ts
const guest = userActor(GUEST_ID);
service = new BookingService(
  new InMemoryBookingRepository(),
  users,
  houses,
  new SequentialIds(),
  new FixedClock(),
  new PassThroughUnitOfWork(),
);
await expect(service.get(userActor(STRANGER_ID), id)).rejects.toBeInstanceOf(NotFoundError);
await service.list(adminActor('admin'), 'any', {}, { limit: 10, after: null });
```

Fakes implement the same abstract port and the **same contract** as the real adapter,
including its failure modes (the in-memory booking repository rejects overlaps like the
exclusion constraint does, and filters by the scope like the SQL does). A fake that is
more permissive than production hides bugs. `SequentialIds` yields sortable UUID-shaped
ids so pagination behaves like UUIDv7. With a `FixedClock`, build dates relative to the
clock (`day(30, clock.now())` from `test/fakes.ts`), never relative to the real date, or
"in the past" rules flip silently.

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
  callers: ['other-service'],          // workloads besides the gateway that call it in this test
});
client = service.client<BookingServiceClient>('ga.booking.v1.BookingService');
...
beforeEach(() => db.truncate('bookings'));
afterAll(async () => { client.close(); await service.close(); await db.dispose(); });

it('books a stay', async () => {
  const asGuest = await service.as(GUEST_ID);   // caller = the gateway, principal = the user
  await client.createBooking(request, asGuest);
});
```

- `createTestDatabase` creates a private schema, runs the real migrations into it and drops
  it in `dispose()`. Parallel test files never see each other's rows.
- `startTestService` boots the real `AppModule` exactly like `main.ts` (same error filter,
  auth guard, `@Access` boot check, health, reflection) on a free port, with ephemeral
  workload keys for the gateway, the service and `callers`. Override **ports**, not
  adapters' internals.

| `TestService` member                                   | Gives                                                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `as(userId \| actor, { roles?, caller? })`             | metadata of a registered user (principal signed by the gateway), sent by the gateway or by `caller` |
| `asIdentity({ issuer, subject, email? }, { caller? })` | a login without a user, for `@Access.identity()` methods                                            |
| `asService(name)`                                      | a workload calling as itself, no principal (`@Access.service`)                                      |
| `anonymous({ caller? })`                               | a caller assertion only: public methods work, user methods answer `PRINCIPAL_MISSING`               |
| `client<C>(grpcService)`                               | typed promise client; a call without metadata uses `anonymous()`                                    |
| `keys`                                                 | the test's workload keys (`signingKey(name)`, `env(name)`) for tests that forge or expire tokens    |
| `url`, `app`, `close()`                                | `127.0.0.1:<port>` (plaintext loopback), the Nest app, shutdown                                     |
- Every workload you pass as `caller` or to `asService` must be in `callers`; keys exist
  only for the gateway, the service and those. Two test services that call each other
  share keys: start the callee with `callers: ['<caller name>']`, then the caller with
  `keys: callee.keys` (see `packages/service-kit/src/auth/grpc-auth.spec.ts`).
- `createGrpcTestClient<C>(service, protoFiles, url, { caFile?, metadata? })` is the client
  underneath: `caFile` for a TLS server (the local stack: `.certs/grpc-ca.pem` with a
  `localhost:<port>` URL), `metadata` for calls that pass none.
- `grpcError(promise)` asserts a failure and returns `{ code, message, details }` with the
  decoded `errorInfo` and `fieldViolations`:

  ```ts
  const error = await grpcError(client.createBooking(overlapping, asGuest));
  expect(error.code).toBe(status.ALREADY_EXISTS);
  expect(error.details?.errorInfo?.reason).toBe('BOOKING_DATES_UNAVAILABLE');
  ```
- Dates relative to the real date (`day(30)`, the system clock is real here) keep
  "not in the past" rules green forever.
- To prove the "dependency down" path through the real adapter, start a second service
  instance without the port override and with `X_SERVICE_URL: '127.0.0.1:1'`: calls fail
  with `UNAVAILABLE` and reason `<DEP>_SERVICE_UNAVAILABLE`.

## The five access tests (every service keeps them)

`templates/service/test/sample-item.grpc.spec.ts` ships them in a `describe('access')`
block; a generated service adapts them to its resources and never deletes them:
1. **No signed-in user**: a call with the default (anonymous) metadata is
   `UNAUTHENTICATED` with reason `PRINCIPAL_MISSING`.
2. **Another user**: get, update and delete answer `NOT_FOUND` with the resource's
   not-found reason, as if it did not exist (or `PERMISSION_DENIED` where the resource is
   public, like houses).
3. **An admin** (`service.as(STRANGER, { roles: ['admin'] })`) reads and changes anyone's
   resource.
4. **A stranger's list** is empty, and the owner's page token replayed by the stranger is
   `INVALID_ARGUMENT`.
5. **An unlisted forwarder** (`service.as(OWNER, { caller: 'other-service' })` with
   `callers: ['other-service']`) is `PERMISSION_DENIED` with reason `CALLER_NOT_ALLOWED`.

When a method lists forwarders in `via`, also prove that a listed one gets through.
Build lists of failing calls as **thunks**, so each call starts when it is awaited: an
array of promises starts every call at once, and a rejection that settles before its
`await` is reported as unhandled.

```ts
for (const call of [
  async () => client.getSampleItem({ id }, stranger),
  async () => client.updateSampleItem({ id, name: 'Mine now' }, stranger),
  async () => client.deleteSampleItem({ id }, stranger),
]) {
  const error = await grpcError(call());
  expect(error.code).toBe(status.NOT_FOUND);
}
```

## Test what production will break on

- **Concurrency** for every invariant: fire N identical requests with `Promise.allSettled`
  and assert exactly one winner (see user-service email race, booking overlap).
- **Error contract**: assert status code and `reason` for every documented error of an RPC.
- **Access**: the five cases above, every role or owner rule, and every `via` entry.
- **Pagination**: page through, check order, last page token empty, token reused with a
  different filter, user or scope -> `INVALID_ARGUMENT`.
- **Partial updates**: unset fields keep their values; concurrent updates of different
  fields both survive.
- **Wire types**: timestamps come back as `Date`, money as integers, enums as strings.

## Gateway tests

Use `createTestGateway(new Map([[USER_SERVICE, fakeUsers]]), { realResolver?, env? })` from
`apps/gateway/test/harness.ts`: it sets every required env var (`TEST_ENV`), boots the
real gateway with the production adapter, configuration and `AuthGuard` (TLS off), runs a
local identity provider (`test-issuer.ts`) and maps logins to users in memory. Authenticate
requests with:
- `headers: await gateway.as(USER_ID)` or `gateway.as(USER_ID, ['admin'])`: a registered user;
- `headers: await gateway.bearer('newcomer', { email: 'a@b.io', emailVerified: true })`: a
  login without a user (registration), or a bad token (`expiresIn: -120`,
  `audience: 'some-client'`);
- `{ realResolver: true }`: logins resolve through the faked user-service client
  (`resolveIdentity`), to test the identity cache.

Write one spec per resource (`test/<resource>.spec.ts`). Fakes return `of(response)` or
`throwError(() => error)`; build gRPC errors with a `Metadata` that carries
`encodeStatusDetails(...)` to test the problem+json mapping. Assert that the gRPC request
carries no id from the body (`ownerId: ''`). When the gateway gains a downstream service,
add its URL to `TEST_ENV`.

## End to end

`tests/e2e/client.ts`: `signUp(name)` registers a fresh dev-IdP login and returns a session
(`userId`, `token`, `call(method, path, body)`); `grantAdmin(userId)` runs
`pnpm users:grant-role` (call it right after `signUp`, before the session's next request:
the gateway caches roles per login); `idpToken(sub, options)`, `bearer(token)` and
`api(...)` send raw requests. `tests/e2e/grpc.ts` signs caller and principal tokens with
the local keys, so `access.e2e.spec.ts` can prove that services refuse calls that do not
come from the platform.

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
- `@ga/kernel/testing` and `@ga/service-kit/testing` are for tests and local tools only;
  `pnpm lint` rejects them in production code.
