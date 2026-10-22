---

name: ga-gateway-endpoint
description: Expose functionality through the public HTTPS REST API in apps/gateway of global-architecture - REST resource and route design, Zod body/query/param schemas that both validate and generate the OpenAPI document, calling the typed gRPC client, mapping replies to public views, RFC 9457 problem+json errors, Location headers, pagination envelope, rate limiting and security headers. Use it whenever a client, frontend or partner needs an endpoint, when a gRPC RPC should become public, or when the OpenAPI docs, error responses or REST field names need to change.
---

# Gateway endpoints

The gateway is the only public entrypoint. It owns the public REST contract and
translates it to gRPC; it holds no business logic and no database. Domain services stay
private and keep their AIP-style gRPC naming; the gateway presents client-friendly REST
(`createdAt`, `status: "CONFIRMED"`, `{ items, nextPageToken }`).

## Anatomy (users is the simplest, bookings shows a custom action)

```
apps/gateway/src/clients.ts                    gRPC client per downstream service (+ config URL)
apps/gateway/src/<resource>/<resource>.schemas.ts   Zod: request bodies/queries + response views + mapper
apps/gateway/src/<resource>/<resource>.controller.ts
apps/gateway/src/app.module.ts                 register the controller
apps/gateway/test/gateway.spec.ts              tests with fake gRPC clients
```

## REST conventions

| Operation      | Route                                                                           | Success                                  |
| -------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| create         | `POST /v1/houses`                                                               | 201 + `Location: /v1/houses/{id}` + body |
| list           | `GET /v1/houses?ownerId=&city=&pageSize=&pageToken=`                            | 200 `{ items, nextPageToken \| null }`   |
| get            | `GET /v1/houses/{id}`                                                           | 200                                      |
| partial update | `PATCH /v1/houses/{id}` (only sent fields change; nested objects replace whole) | 200                                      |
| delete         | `DELETE /v1/houses/{id}`                                                        | 204                                      |
| custom action  | `POST /v1/bookings/{id}/cancel`                                                 | 200 + resource                           |

Paths are versioned (`/v1`), plural nouns, camelCase JSON, ISO-8601 timestamps,
`YYYY-MM-DD` dates, money as `{ currencyCode, amountMinor }`, enums without the proto
prefix.

## Schemas: one Zod schema = validation + documentation

```ts
export const CreateHouseBody = z.object({
  ownerId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  ...
}).meta({ id: 'CreateHouseBody' });          // becomes components/schemas/CreateHouseBody

export const HouseView = z.object({ id: z.uuid(), ..., createdAt: z.iso.datetime() })
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
  @ApiOperation({ summary: 'List a house for an existing owner' })
  @ApiResponse({ status: 201, standardSchema: HouseView })
  async create(@Body({ schema: CreateHouseBody }) body: z.output<typeof CreateHouseBody>,
               @Res({ passthrough: true }) reply: FastifyReply) {
    const view = toHouseView((await firstValueFrom(this.houses.createHouse(body))).house);
    void reply.header('location', `/v1/houses/${view.id}`);
    return view;
  }

  @Get(':id')
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
follows `google/rpc/code.proto` (`GRPC_TO_HTTP_STATUS` in the service kit).

## Adding a new downstream service to the gateway

1. `apps/gateway/src/config.ts`: `X_SERVICE_URL: grpcTarget()`; `.env.example`.
2. `apps/gateway/src/clients.ts`: token + entry in `GrpcClientsModule.register`.
3. `apps/gateway/src/health/health.controller.ts`: add it to the readiness targets.
4. Controller + schemas, register the controller in `app.module.ts`.
5. Tests in `apps/gateway/test/` with the client overridden by `vi.fn()` fakes; then the
   e2e suite (`tests/e2e`) against the running stack.

## Cross-cutting behaviour (already on, do not re-implement)

HTTPS with HTTP/2 + HTTP/1.1, security headers (strict CSP; `/docs` gets its own),
optional CORS allowlist (`CORS_ORIGINS`), rate limit per IP (`RATE_LIMIT_PER_MINUTE`,
`@SkipThrottle()` for probes), 1 MB body limit, `x-request-id` in and out, structured
access logs, `/healthz` (liveness), `/readyz` (all downstream services SERVING),
`/openapi.json` and `/docs` (on unless `NODE_ENV=production`).

**There is no authentication yet** (ADR-0004). Do not add endpoints that expose data
across users as if it were protected; flag the gap in the PR instead.
