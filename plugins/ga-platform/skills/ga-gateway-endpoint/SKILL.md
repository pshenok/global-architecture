---

name: ga-gateway-endpoint
description: Expose functionality through the public HTTPS REST API in apps/gateway of global-architecture - REST resource and route design, who may call a route (signed-in users by default, @Public(reason), @AllowUnregistered()), Zod body/query/param schemas that both validate and generate the OpenAPI document, calling the typed gRPC client, mapping replies to public views, RFC 9457 problem+json errors including 401/403, Location headers, pagination envelope, rate limiting and security headers. Use it whenever a client, frontend or partner needs an endpoint, when a gRPC RPC should become public, when a route should work without signing in, or when the OpenAPI docs, error responses or REST field names need to change.
---

# Gateway endpoints

The gateway is the only public entrypoint. It owns the public REST contract and
translates it to gRPC; it holds no business logic and no database. Domain services stay
private and keep their AIP-style gRPC naming; the gateway presents client-friendly REST
(`createdAt`, `status: "CONFIRMED"`, `{ items, nextPageToken }`). It authenticates every
request; authorization (owner, admin, visibility) stays in the service that owns the data.

## Anatomy (users is the simplest, bookings shows a custom action)

```
apps/gateway/src/clients.ts                    gRPC client per downstream service (+ config URL)
apps/gateway/src/auth/                         AuthGuard, @Public / @AllowUnregistered, IdP keys, identity cache
apps/gateway/src/<resource>/<resource>.schemas.ts   Zod: request bodies/queries + response views + mapper
apps/gateway/src/<resource>/<resource>.controller.ts
apps/gateway/src/app.module.ts                 register the controller
apps/gateway/test/harness.ts                   createTestGateway(): real gateway and AuthGuard, fake gRPC clients
apps/gateway/test/<resource>.spec.ts           one spec per resource
```

## Who may call a route

`AuthGuard` runs on every route. Unless a route is decorated, it needs a **registered
user**: the guard verifies the bearer token, maps the login to its user and signs a
principal that the gRPC clients forward, so the services know the user without any code
in the controller.

| Route                       | Decorator                                             | The service sees                                       |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| a registered user (default) | none                                                  | the user: `@Access.user()` / `@Access.admin()` methods |
| registration only           | `@AllowUnregistered()`                                | the login without a user: `@Access.identity()` methods |
| anyone                      | `@Public('reason')` on the method (or the controller) | an anonymous call: `@Access.public(...)` methods only  |
- Every `@Public` route is listed in `security/public-endpoints.json` with the same reason
  (`{ "where": "apps/gateway/src/houses/houses.controller.ts#HousesController.list", "access": "public", "reason": "world-readable catalogue" }`);
  the list has code owners. Two checks compare it with the code: `pnpm lint`
  (`check-access`, type-aware) with the source, and every gateway test boot with the
  route modes `AuthRoutes` recorded at boot, which are what `AuthGuard` enforces. Write
  `@Public('reason')` directly above the method or controller, reason inline in any quote
  style. `check-access` fails any other use of `Public`, `AllowUnregistered` or their
  metadata: a constant or computed reason, a wrapper (`applyDecorators(..., Public(...))`),
  a renamed import, a decorator kept in a constant, `SetMetadata(AUTH_ROUTE, ...)`.
- Routes are controller methods. Routes added on the HTTP adapter or the Fastify instance,
  and Nest middleware, skip the auth guard, so only `bootstrap.ts` and `http/openapi.ts`
  (`/openapi.json`, `/docs`, only with `DOCS_ENABLED`; both code-owned) touch them:
  `check-access` fails `HttpAdapterHost`, `getHttpAdapter`, `getInstance`, `use`,
  `MiddlewareConsumer` and Fastify route methods anywhere else, and `createTestGateway`
  fails on any route, hook, plugin or middleware another gateway file adds.
- A token sent to a public route is still verified (a bad one is a 401, never a silent
  downgrade; during an IdP outage it is skipped instead of failing the route), but it is
  neither resolved nor forwarded, so a public route can only call `@Access.public` RPCs.
  Probes use `@Public(reason, { ignoreToken: true })` and never look at the header.
- `@AllowUnregistered()` is for registration (`POST /v1/users`) only.
- Never take the acting user's id from the body, query or path: the services take owner,
  guest and user from the principal. `me` means the signed-in user (`/v1/users/me`; the
  controller maps it with `currentUser().userId` from `@ga/service-kit`). Ids that address
  other resources (`houseId`) or filter a public list (`ownerId`) are fine.
- Generated request types keep deprecated identity fields required until they are
  reserved. Send `''` (the services ignore it) with the documented lint exception, as in
  `HousesController.create`:

  ```ts
  // oxlint-disable-next-line typescript/no-deprecated -- the generated type requires it until the field is reserved
  (await firstValueFrom(this.houses.createHouse({ ...body, ownerId: '' }))).house,
  ```

## REST conventions

| Operation          | Route                                                                           | Success                                  |
| ------------------ | ------------------------------------------------------------------------------- | ---------------------------------------- |
| create             | `POST /v1/houses`                                                               | 201 + `Location: /v1/houses/{id}` + body |
| list               | `GET /v1/houses?ownerId=&city=&pageSize=&pageToken=`                            | 200 `{ items, nextPageToken \| null }`   |
| list own data      | `GET /v1/bookings?as=guest\|host\|any` (scoped by the service)                  | 200 `{ items, nextPageToken \| null }`   |
| get                | `GET /v1/houses/{id}`                                                           | 200                                      |
| the signed-in user | `GET`/`PATCH`/`DELETE /v1/users/me`                                             | 200 / 200 / 204                          |
| partial update     | `PATCH /v1/houses/{id}` (only sent fields change; nested objects replace whole) | 200                                      |
| delete             | `DELETE /v1/houses/{id}`                                                        | 204                                      |
| custom action      | `POST /v1/bookings/{id}/cancel`                                                 | 200 + resource                           |

Status codes need decorators: Nest answers `@Post()` with 201 and `@Delete()` with 200,
so a delete needs `@HttpCode(204)` and a custom action (`POST .../cancel`) needs
`@HttpCode(200)`.

Paths are versioned (`/v1`), plural nouns, camelCase JSON, ISO-8601 timestamps,
`YYYY-MM-DD` dates, money as `{ currencyCode, amountMinor }`, enums without the proto
prefix.

## Schemas: one Zod schema = validation + documentation

```ts
/** The owner is the signed-in user; it is never taken from the body. */
export const CreateHouseBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  ...
}).meta({ id: 'CreateHouseBody' });          // becomes components/schemas/CreateHouseBody

export const HouseView = z.object({ id: z.uuid(), ownerId: z.uuid(), ..., createdAt: z.iso.datetime() })
  .meta({ id: 'House' });

export function toHouseView(house: House | null | undefined): z.output<typeof HouseView> { ... }
```

Mirror the service's limits so clients get errors before a network hop, and so the
OpenAPI document tells the truth. The service validates again; that is intended.

## Controller

```ts
@ApiTags('houses')
@ApiResponse({ status: 400, description: 'Invalid input', standardSchema: ProblemDetails })
@ApiResponse({ status: 503, description: 'A service is unavailable', standardSchema: ProblemDetails })
@Controller('v1/houses')
export class HousesController {
  constructor(@Inject(HOUSE_SERVICE) private readonly houses: HouseServiceClient) {}

  @Post()
  @ApiOperation({ summary: 'List a house; the signed-in user becomes its owner' })
  @ApiResponse({ status: 201, standardSchema: HouseView })
  async create(@Body({ schema: CreateHouseBody }) body: z.output<typeof CreateHouseBody>,
               @Res({ passthrough: true }) reply: FastifyReply) {
    const view = toHouseView(
      // oxlint-disable-next-line typescript/no-deprecated -- the generated type requires it until the field is reserved
      (await firstValueFrom(this.houses.createHouse({ ...body, ownerId: '' }))).house,
    );
    void reply.header('location', `/v1/houses/${view.id}`);
    return view;
  }

  @Get(':id')
  @Public('world-readable catalogue')
  async get(@Param('id', { schema: IdParam }) id: string) { ... }
}
```

- `@Body/@Query/@Param({ schema })` are validated by the global
  `StandardSchemaValidationPipe`; failures become 400 problem+json with `errors[]`.
- Query strings are strings: use `z.coerce.number()` (see `PageQuery` in `http/schemas.ts`).
- Under `exactOptionalPropertyTypes`, do not pass `undefined` for optional **message**
  fields of a gRPC request; omit the key (see `HousesController.update`).
- Do not catch errors in controllers. `ProblemDetailsFilter` maps every gRPC status
  (with `ErrorInfo` reason, domain, metadata and field violations) to the right HTTP status.
- OpenAPI security is automatic (`applySecurity` in `http/openapi.ts`): the document
  requires the bearer scheme globally, `@Public` operations get `security: []`, and every
  other operation gets 401 and 403 responses. Declare a 403 yourself only to document a
  route-specific reason (registration documents `EMAIL_NOT_VERIFIED`).

## Errors clients see

```json
{
  "type": "about:blank",
  "title": "Conflict",
  "status": 409,
  "detail": "the house is already booked for some of these dates",
  "instance": "/v1/bookings",
  "code": "BOOKING_DATES_UNAVAILABLE",
  "domain": "booking-service",
  "metadata": { "houseId": "..." },
  "requestId": "..."
}
```

`code` is the stable field clients branch on. For 5xx, `detail` is omitted. Status mapping
follows `google/rpc/code.proto` (`GRPC_TO_HTTP_STATUS` in the service kit). Authentication
adds these:

| Status | `code`                                                             | When                                                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`   | no, bad or expired bearer token; the response carries `WWW-Authenticate: Bearer realm="ga"` (plus `error="invalid_token"` when a token was sent)                                                                 |
| 403    | `USER_NOT_REGISTERED`                                              | a valid login without a user: register with `POST /v1/users`                                                                                                                                                     |
| 403    | `EMAIL_NOT_VERIFIED`                                               | registration, when the issuer's email policy needs a verified email                                                                                                                                              |
| 403    | service reasons (`HOUSE_PERMISSION_DENIED`, `ADMIN_ROLE_REQUIRED`) | passed through from the service                                                                                                                                                                                  |
| 503    | `IDENTITY_PROVIDER_UNAVAILABLE`, `USER_SERVICE_UNAVAILABLE`        | the IdP's keys cannot be loaded (never a 401, so clients keep valid tokens), or an unknown login while user-service is down                                                                                      |
| 500    | `INTERNAL`                                                         | a service answered UNAUTHENTICATED, or PERMISSION_DENIED with a platform reason (`PLATFORM_AUTH_FAULTS`: `CALLER_NOT_ALLOWED`, `ACCESS_NOT_DECLARED`, ...): the gateway called it wrongly, which is a server bug |

## Adding a new downstream service to the gateway

1. `apps/gateway/src/config.ts`: `X_SERVICE_URL: grpcTarget()` (required, no default), and
   the value (`localhost:<port>`: a host name, because gRPC runs TLS) in
   `apps/gateway/.env.example`, your local `apps/gateway/.env` (or rerun `pnpm stack:up`,
   which injects every `*_SERVICE_URL` from `services.json`) and `TEST_ENV` in
   `apps/gateway/test/harness.ts`.
2. `apps/gateway/src/clients.ts`: token + entry in `GrpcClientsModule.register` with
   `target: 'x-service'` (the callee's workload name).
3. `apps/gateway/src/health/health.controller.ts`: add it to the readiness targets.
4. Controller + schemas, register the controller in `app.module.ts`. The gateway is the
   principal issuer, so the service's `@Access.user()` methods accept it without `via`.
5. Tests in `apps/gateway/test/<resource>.spec.ts` via `createTestGateway` with the client
   overridden by `vi.fn()` fakes; authenticate with `headers: await gateway.as(USER_ID)`
   (or `gateway.as(USER_ID, ['admin'])`), and use `gateway.bearer('newcomer', { ... })` for
   a login without a user or a bad token (see `ga-testing`). Assert that ids from the body
   never reach the gRPC request. Then the e2e suite (`tests/e2e`) against the running stack.

## Cross-cutting behaviour (already on, do not re-implement)

HTTPS with HTTP/2 + HTTP/1.1, authentication of every route (`AuthGuard`) and principal
forwarding, security headers (strict CSP; `/docs` gets its own), optional CORS allowlist
(`CORS_ORIGINS`; `www-authenticate` is an exposed header), rate limit per IP
(`RATE_LIMIT_PER_MINUTE`, `@SkipThrottle()` for probes), 1 MB body limit, `x-request-id`
in and out, structured access logs (the `authorization` header is redacted), `/healthz`
(liveness), `/readyz` (all downstream services SERVING; `identityProvider` is reported but
does not fail readiness), `/openapi.json` and `/docs` (on unless `NODE_ENV=production`).
