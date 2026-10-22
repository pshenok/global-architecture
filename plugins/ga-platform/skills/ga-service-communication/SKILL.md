---

name: ga-service-communication
description: How global-architecture services call each other - typed gRPC clients via GrpcClientsModule, ports and anti-corruption adapters, deadlines, retries, request-id propagation, mapping downstream gRPC errors (NOT_FOUND, UNAVAILABLE) to domain errors, avoiding call cycles and distributed transactions, and when an event would be the better tool. Use it whenever a service needs data or an action from another service, when adding a dependency between services, or when debugging timeouts, UNAVAILABLE or DEADLINE_EXCEEDED between services.
---

# Calling another service

Services never share databases. If house-service needs to know whether a user exists,
it asks user-service over gRPC. Every such dependency is visible in three places: the
service's config, its `GrpcClientsModule.register(...)`, and a port in its application layer.

## Steps (house-service -> user-service is the reference)

1. **Port** in `src/application/ports/user-directory.ts`, phrased in your domain's terms:

   ```ts
   export abstract class UserDirectory {
     /** Throws DependencyUnavailableError when user-service cannot be reached. */
     abstract exists(userId: string): Promise<boolean>;
   }
   ```
2. **Config** in `src/config.ts`: `USER_SERVICE_URL: grpcTarget()`, plus
   `USER_SERVICE_URL=localhost:50051` in `.env` and `.env.example`. The local stack
   injects every `*_SERVICE_URL` from `services.json` automatically.
3. **Client module** in `src/infrastructure/clients/`:

   ```ts
   export const USER_SERVICE = Symbol('USER_SERVICE');
   export const UserServiceClientModule = GrpcClientsModule.register([{
     token: USER_SERVICE,
     service: 'ga.user.v1.UserService',
     protoFiles: ['ga/user/v1/user.proto'],
     url: (config) => String(config.USER_SERVICE_URL),
     timeoutMs: 2_000,
   }]);
   ```
4. **Adapter** (anti-corruption layer) implementing the port:

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
   `@Inject(TOKEN)` supplies the DI token.
5. **Bind** in `app.module.ts`: import `UserServiceClientModule`, provide
   `{ provide: UserDirectory, useClass: GrpcUserDirectory }`.
6. **Test** with a fake port (`overrideProvider(UserDirectory).useValue(fake)`), so service
   tests never need the other service running (see `ga-testing`).

## What the platform does for every outbound call

- **Deadline**: `timeoutMs` (default 3 s) unless the call sets its own; the callee sees it
  and stops work when the caller gave up.
- **Retry**: up to 3 attempts with backoff, only for `UNAVAILABLE` (the request was not
  processed). Other codes are never retried automatically.
- **Request id**: the current `x-request-id` is copied into the call's metadata, so one id
  links the gateway, this service and the callee in the logs.
- **Lazy connection**: a service starts even when its dependencies are down; calls fail
  with `UNAVAILABLE` until they come up, and the adapter turns that into
  `DependencyUnavailableError` (-> 503 at the gateway).

## Mapping downstream errors

Decide per call which downstream codes are business outcomes for you:

| Downstream says                                                       | Usually means for you                                                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `NOT_FOUND`                                                           | `null` / `false` from the port; the use case raises its own `PreconditionFailedError` (e.g. `BOOKING_HOUSE_NOT_FOUND`) |
| `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`, `CANCELLED` | `toDependencyError(error, 'house-service')` -> `DependencyUnavailableError`                                            |
| `INVALID_ARGUMENT`                                                    | a bug in your adapter (you validated first); let it surface as INTERNAL                                                |
| anything else                                                         | rethrow; it surfaces as INTERNAL and is logged                                                                         |

Never forward a downstream error message to your caller verbatim from domain code; your
API's errors are part of your contract.

## Design rules for a system of hundreds of services

- **No cycles.** Dependencies form a DAG (today: booking -> house -> user, booking ->
  user). If A must react to something in B and B already calls A, that reaction is an
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
- **Know what a check is worth.** "The user exists" is true at check time only; the user
  can be deleted a second later. Such references are eventually consistent until the
  event-driven cleanup in `docs/architecture/adr/0005-asynchronous-events.md` exists.

## Asynchronous events (planned, not built yet)

Use an event, not a call, when: the producer should not know the consumers, the work can
happen later, or the reaction would create a call cycle. The agreed design (ADR-0005):
transactional outbox table per service, a relay publishing to a broker, consumers
deduplicating by event id. Until that lands, do not invent ad-hoc queues; raise it.
