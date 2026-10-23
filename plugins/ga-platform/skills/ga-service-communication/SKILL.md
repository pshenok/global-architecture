---

name: ga-service-communication
description: How global-architecture services call each other - typed gRPC clients via GrpcClientsModule (target workload, TLS, host-name URLs), signed caller assertions and forwarded user principals, callee @Access via lists and service-to-service access, ports and anti-corruption adapters, deadlines, retries, request-id propagation, mapping downstream gRPC errors (NOT_FOUND, UNAVAILABLE, UNAUTHENTICATED, PERMISSION_DENIED) to domain errors, snapshots for authorization, avoiding call cycles and distributed transactions, and when an event would be the better tool. Use it whenever a service needs data or an action from another service, when adding a dependency between services, or when debugging timeouts, UNAVAILABLE, DEADLINE_EXCEEDED, CALLER_NOT_ALLOWED or TLS errors between services.
---

# Calling another service

Services never share databases. If house-service needs to know whether a user exists,
it asks user-service over gRPC. Every such dependency is visible in four places: the
service's config, its `GrpcClientsModule.register(...)`, a port in its application layer,
and the callee's `@Access` declaration that lets it in.

## Steps (house-service -> user-service is the reference)

1. **Port** in `src/application/ports/user-directory.ts`, phrased in your domain's terms:

   ```ts
   export abstract class UserDirectory {
     /** Throws DependencyUnavailableError when user-service cannot be reached. */
     abstract exists(userId: string): Promise<boolean>;
   }
   ```
2. **Config** in `src/config.ts`: `USER_SERVICE_URL: grpcTarget()`, plus
   `USER_SERVICE_URL=localhost:50051` in `.env` and `.env.example`. Use a host name, not
   `127.0.0.1`: with TLS, the client refuses IP addresses (`cannot verify TLS for ...`).
   The local stack injects every `*_SERVICE_URL` from `services.json` (as
   `localhost:<port>`) and `GRPC_TLS_CA_FILE` automatically.
3. **Client module**, one file per dependency named `src/infrastructure/clients/<dep>-service.client.ts`,
   exporting `<DEP>_SERVICE` and `<Dep>ServiceClientModule`:

   ```ts
   export const USER_SERVICE = Symbol('USER_SERVICE');
   export const UserServiceClientModule = GrpcClientsModule.register([{
     token: USER_SERVICE,
     target: 'user-service',          // the callee's workload name (services.json)
     service: 'ga.user.v1.UserService',
     protoFiles: ['ga/user/v1/user.proto'],
     url: (config) => String(config.USER_SERVICE_URL),
     timeoutMs: 2_000,
   }]);
   ```

   `target` is the audience of the caller assertion: a wrong name fails every call with
   `UNAUTHENTICATED` `CALLER_INVALID`. Adapters import `status` from `@grpc/grpc-js` at
   runtime; it is a regular `dependency` of every service (not a devDependency), so
   production images keep it.
4. **Access on the callee.** The callee's method must let you in. A method that acts for
   the user lists you as a forwarder:

   ```ts
   // user-service: house-service and booking-service look up the acting user's own account.
   @Access.user({ via: ['house-service', 'booking-service'] })
   async getUser(request: GetUserRequest): Promise<GetUserResponse> { ... }
   ```

   Without it your call fails with `PERMISSION_DENIED` `CALLER_NOT_ALLOWED`. A `via` entry
   lets your service act as any user whose request passes through it, on that method
   only, so it is a reviewed change to the callee: update its proto `// Access:` line and
   its tests (`callers: ['house-service']`, `service.as(id, { caller: 'house-service' })`).
5. **Adapter** (anti-corruption layer) in `src/infrastructure/clients/grpc-<port-name>.ts`,
   implementing the port:

   ```ts
   @Injectable()
   export class GrpcUserDirectory extends UserDirectory {
     constructor(@Inject(USER_SERVICE) private readonly users: UserServiceClient) { super(); }
     async exists(userId: string): Promise<boolean> {
       try {
         await firstValueFrom(this.users.getUser({ id: userId }));
         return true;
       } catch (error) {
         if (grpcStatusOf(error) === status.NOT_FOUND) return false;
         throw toDependencyError(error, 'user-service');
       }
     }
   }
   ```

   `UserServiceClient` is an interface, so it is `import type`; the explicit
   `@Inject(TOKEN)` supplies the DI token. Never pass `x-ga-*` metadata yourself.
6. **Bind** in `app.module.ts`: import `UserServiceClientModule`, provide
   `{ provide: UserDirectory, useClass: GrpcUserDirectory }`.
7. **Test**: a unit test of the adapter with the typed client faked
   (`src/infrastructure/clients/grpc-user-directory.spec.ts` in house-service), and service
   tests with a fake port (`overrideProvider(UserDirectory).useValue(fake)`). Config still
   validates `USER_SERVICE_URL` at boot, so pass `env: { USER_SERVICE_URL: '127.0.0.1:1' }`
   to `startTestService` (plaintext loopback is allowed when no CA is set; see `ga-testing`).

## What the platform does for every outbound call

- **Identity**: a caller assertion signed by this workload for `target` (`x-ga-caller`,
  60 s, cached and re-signed at half its lifetime) and the principal of the current
  request (`x-ga-principal`), if there is one. Both keys set at the call site are removed
  and replaced, so code cannot call as another user or another workload.
- **TLS**: with `GRPC_TLS_CA_FILE` set, the callee's certificate is verified; without it
  only loopback targets are allowed (`refusing to call ... over plaintext gRPC`).
- **Deadline**: `timeoutMs` (default 3 s). The caller gets `DEADLINE_EXCEEDED` when it
  expires, but the callee's handler is **not** cancelled: it runs to completion and its
  reply is discarded. Do not rely on a deadline to stop work. The generated client
  interface takes `(request, metadata)` only, so a per-call deadline needs a cast; prefer
  choosing `timeoutMs` per dependency.
- **Retry**: up to 3 attempts with backoff for `UNAVAILABLE` that comes from the transport
  (connection refused, server restarting: the handler never ran). When a handler itself
  returns `UNAVAILABLE` (a `DependencyUnavailableError`), the service kit adds
  `grpc-retry-pushback-ms: -1` and callers do **not** retry, so one outage is not
  multiplied by 3 at every hop. Other codes are never retried.
- **Request id**: the current `x-request-id` is copied into the call's metadata, so one id
  links the gateway, this service and the callee in the logs.
- **Lazy connection**: a service starts even when its dependencies are down; calls fail
  with `UNAVAILABLE` until they come up, and the adapter turns that into
  `DependencyUnavailableError` (-> 503 at the gateway).

## With or without a user

| The call happens                                | Callee declares                                                       | The callee sees                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| while serving a user's request (the usual case) | `@Access.user({ via: ['<you>'] })` or `@Access.admin({ via: [...] })` | the same user (`currentUser()`)                                             |
| for public data                                 | `@Access.public('<reason>')`                                          | an anonymous call; any workload may call                                    |
| with no user: jobs, future event consumers      | `@Access.service(['<you>'])`                                          | a `ServiceActor` named after you (`currentActor()`); principals are ignored |

Only edges (the gateway, `PRINCIPAL_ISSUERS`) sign principals, so a service can never act
for a user who did not send the current request. A forwarded call is authorized as that
user and sees only what the user may see: `GetUser` for someone else answers `NOT_FOUND`.

## Mapping downstream errors

Decide per call which downstream codes are business outcomes for you:

| Downstream says                                                                                                                                 | Usually means for you                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_FOUND`                                                                                                                                     | `null` / `false` from the port; the use case raises its own `PreconditionFailedError` (e.g. `BOOKING_HOUSE_NOT_FOUND`)                                                                                               |
| `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`, `CANCELLED`                                                                           | `toDependencyError(error, 'house-service')` -> `DependencyUnavailableError` with reason `HOUSE_SERVICE_UNAVAILABLE` (dependency name upper-snaked + `_UNAVAILABLE`)                                                  |
| `UNAUTHENTICATED`, or `PERMISSION_DENIED` with a platform reason (`CALLER_NOT_ALLOWED`, `PRINCIPAL_NOT_REGISTERED`, `ACCESS_NOT_DECLARED`, ...) | a bug in how you call: a missing `via` entry, a wrong `target`, a user method called without a user, a key mismatch. Rethrow; it surfaces as INTERNAL here and as 500 at the gateway, never as 401/403 to the client |
| `INVALID_ARGUMENT`                                                                                                                              | a bug in your adapter (you validated first); let it surface as INTERNAL                                                                                                                                              |
| anything else                                                                                                                                   | rethrow; it surfaces as INTERNAL and is logged                                                                                                                                                                       |

`toDependencyError` returns every non-transient error unchanged, which is why the adapter
can `throw toDependencyError(error, ...)` for everything except the codes it maps itself.
Fakes of the port should throw the same errors.

Map the other service's enums through an explicit table with a default the domain
rejects (an unknown or `_UNSPECIFIED` value must not slip through), and treat a missing
message field in a reply (it arrives as `null`) as a contract bug:
`throw new Error('house-service returned an incomplete house')` -> INTERNAL.

Never forward a downstream error message to your caller verbatim from domain code; your
API's errors are part of your contract.

## Design rules for a system of hundreds of services

- **No cycles.** Dependencies form a DAG (see `docs/architecture/overview.md`). If A must react to something in B and B already calls A, that reaction is an
  event, not a call.
- **No distributed transactions.** Do remote reads first, then one local transaction.
  Never call another service while a database transaction is open.
- **Parallelize independent calls** (`Promise.all`), as booking-service does for the
  guest and house checks.
- **Keep fan-out shallow.** A request that crosses more than about three hops will be slow
  and fragile; denormalize what you need (with an event to keep it fresh) instead.
- **Store references, not copies**: keep `owner_id`, not the owner's name. If you must
  copy (a price at booking time), copy it deliberately and name it as a snapshot
  (`total_price` is "frozen at booking time").
- **Snapshot immutable facts that authorization needs.** A booking stores the house owner
  as `host_id` when it is created (houses never change owner), so "may the host see this
  booking" needs no call to house-service on every read. If such a fact ever becomes
  mutable, an event must update the snapshots (ADR-0005).
- **Know what a check is worth.** "The user exists" is true at check time only; the user
  can be deleted a second later. Such references are eventually consistent until the
  event-driven cleanup in `docs/architecture/adr/0005-asynchronous-events.md` exists.

## Asynchronous events (planned, not built yet)

Use an event, not a call, when: the producer should not know the consumers, the work can
happen later, or the reaction would create a call cycle. The proposed design (ADR-0005,
not yet accepted; the broker is an open decision):
transactional outbox table per service, a relay publishing to a broker, consumers
deduplicating by event id. Events carry no user principal; consumers will call other
services as themselves (`@Access.service([...])`). Until that lands, do not invent ad-hoc
queues; raise it.
