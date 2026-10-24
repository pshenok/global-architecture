# ADR-0004: Identity and authorization

- Status: Accepted
- Date: 2026-10-23
- Supersedes: the proposal of 2026-10-22 (unsigned `x-principal-id` headers)

## Context

Until now every endpoint was anonymous: any caller could change or delete any user,
house or booking. The platform will run hundreds of services written by many people
and AI agents, so authentication and authorization must be secure by default, cheap
to get right in a new service, and loud when someone gets it wrong. Constraints at
the time of the decision: no infrastructure (no IdP deployment, no service mesh), and
the identity provider is not chosen yet.

Threat model: the internal network is not trusted (any process that can open a gRPC
connection could call a service), a single service can be buggy or compromised, and
tokens can leak (logs, debugging). The design was chosen from three independent
designs (security-first, reliability-first, developer-experience-first), scored by
three judges, merged and then attacked by an adversarial reviewer.

## Decision

### 1. Authentication happens once, at the edge

The gateway verifies OIDC **access tokens** of any configured provider
(`AUTH_ISSUERS`, one to five issuers, so an IdP migration can trust two at once):
asymmetric algorithms only (`none` and HS* cannot be configured), exact issuer and
audience (the API's own audience, never a client id), required `kid`, `exp`, `iat` and
`sub`, `nbf` honoured, `AUTH_CLOCK_TOLERANCE_S` (30 s) of skew, and ID tokens
(`nonce`, `at_hash`, `c_hash`) refused.

Provider keys are fetched by one background loop per provider: every
`AUTH_JWKS_REFRESH_S` (5 min), and after a failure again within seconds (backoff up to
5 s without usable keys, 30 s with). A request never starts a fetch of its own while
the keys are unusable; it only waits for one already running. The last good keys keep
working for `AUTH_JWKS_MAX_STALE_S` (30 min, at least twice the refresh interval) while
refreshes fail; after that, and while no keys were ever loaded, requests get
**503 IDENTITY_PROVIDER_UNAVAILABLE, never 401**, so clients do not throw valid tokens
away. A token with an unknown `kid` triggers at most one extra fetch per
`AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S`, measured from the previous unknown-kid fetch, so key
rotation works within seconds and forged kids cannot hammer the provider. It is a 401
only when the last fetch succeeded without that kid; while fetches fail it is a 503
(the key may be new). `/readyz` reports the provider's state but does not fail on it:
public routes and cached keys keep working during an IdP outage.

Routes need a registered user unless they are `@Public(reason)` (health probes, the
house catalogue) or `@AllowUnregistered()` (registration). A token sent to a public
route is still verified (a bad one is a 401, never a silent downgrade, unless the
provider is unavailable, which does not fail a public route), but it is neither
resolved nor forwarded. Health probes ignore the Authorization header altogether
(`@Public(reason, { ignoreToken: true })`). 401 responses carry
`WWW-Authenticate: Bearer` (RFC 6750).

### 2. Platform users are separate from identity-provider logins

`users.id` stays an application-generated UUIDv7; every other service references it
(`houses.owner_id`, `bookings.guest_id`, `bookings.host_id`). user-service owns
`user_identities (issuer, subject) -> user_id`. One user can have several logins, and
two issuers with the same `sub` are different logins.
- **Registration** (`POST /v1/users`, `RegisterUser`) is explicit. The issuer, subject
  and email come from the verified token, never from the request body. The email
  follows the issuer's `emailPolicy`: `verified-claim` (default: `email` +
  `email_verified`, else userinfo), `userinfo`, `trusted-claim` (only for a provider
  whose emails the operator controls) or `none` (users without email are allowed).
  Concurrent registrations of one login yield one user; the losers get
  `USER_ALREADY_REGISTERED`.
- **Resolution**: the gateway maps every login to its user through
  `ResolveIdentity`, cached for `IDENTITY_CACHE_TTL_S` (60 s), "not registered" for
  `IDENTITY_CACHE_NEGATIVE_TTL_S` (5 s). A gateway clears what it cached for a login it
  registers (also when the login turns out to be registered already) and for a user it
  deletes, including lookups still in flight; other replicas catch up within the TTLs.
  While user-service is unreachable a known mapping keeps serving for
  `IDENTITY_CACHE_STALE_IF_ERROR_S` (5 min); unknown logins get 503.
- **Roles** are platform data in `users.roles` (today: `admin`), granted and revoked
  with `pnpm users:grant-role|users:revoke-role <userId> admin --by <name>` inside
  user-service. Each change prints one line naming who made it (`--by`, else the OS user
  the CLI runs as, which in a container is the image's user); that line is the only
  record, so runbooks keep it. An IdP role never becomes a
  platform role, so an IdP administrator is not a platform administrator. Role changes
  and deletions reach requests within the cache TTL, or the stale window while
  user-service is unreachable; to cut off a compromised admin at once, revoke the role,
  then restart the gateways (their caches are in memory).
- Logins are **never linked by email** (that would let an IdP with weak email
  verification take accounts over). Moving to another IdP means inserting
  `user_identities` rows for the new subjects first, then adding the new issuer, then
  removing the old one (in the other order, early logins would register as new users).

### 3. Two signed tokens on every internal call

Every workload (the gateway and each service) has its own Ed25519 key
(`WORKLOAD_KEY_FILE`, a secret) and trusts one public key map (`WORKLOAD_KEYS_FILE`,
not secret). Both are re-read every `WORKLOAD_KEYS_RELOAD_S`, so keys rotate without
restarts: a broken map keeps the last good one, and a new private key is used only once
the workload's own map publishes its public half. Other workloads may reload the map up
to one interval later, so the runbook publishes the key everywhere before the switch.

| gRPC metadata    | Signed by                                   | Says                                      | Lifetime   |
| ---------------- | ------------------------------------------- | ----------------------------------------- | ---------- |
| `x-ga-caller`    | the calling workload, per hop               | "workload A calls workload B" (`aud` = B) | 60 s       |
| `x-ga-principal` | an edge (`PRINCIPAL_ISSUERS`, i.e. gateway) | the end user (`sub` + `roles`) or a login | 60 s, ≤120 |

The service kit signs and sets both on every outbound call (replacing anything set at
the call site), and verifies both on every inbound call. A service can never mint a
principal; a leaked principal is useless without the right caller key; a compromised
service can act as a user only on methods that list it as a forwarder (below), and
only for users whose requests pass through it.

gRPC uses TLS whenever it leaves the machine: a service refuses to bind a non-loopback
address without `GRPC_TLS_CERT_FILE`/`GRPC_TLS_KEY_FILE`, and a client refuses a
non-loopback target without `GRPC_TLS_CA_FILE`. The local stack runs TLS on every hop
with a local CA (`pnpm certs`), which gives every service the same server certificate;
in a deployment each workload gets its own. Certificates and the CA bundle are read at
start, so renewing them is a rolling restart, done well before they expire. Kubernetes
native gRPC probes cannot speak TLS, so with `GRPC_HEALTH_PORT` (8081 in the images) a
service also serves `grpc.health.v1`, and nothing else, in plaintext on that port.

### 4. Every RPC declares its access policy

`GrpcPlatformModule` installs `GrpcAuthGuard` in every service, without an off switch.
Each gRPC method carries exactly one `@Access` decorator, and a service with an
undeclared method refuses to start (so the first test fails, not production):

| Policy                       | Who may call                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `@Access.user({ via? })`     | a registered user, principal from an edge or from the services listed in `via` |
| `@Access.admin({ via? })`    | the same, with the admin role                                                  |
| `@Access.identity()`         | a login without a user (registration and resolution only)                      |
| `@Access.service([callers])` | the listed workloads, as themselves (jobs, event consumers): no user           |
| `@Access.public(reason)`     | any workload; the handler never sees who the user is                           |

Every call, public ones included, must carry a valid caller assertion. Health checks
and reflection are not Nest handlers and stay open (reflection is off in production
unless `GRPC_REFLECTION=true`).

### 5. Authorization lives in the service that owns the data

Controllers take the actor from the request context (`currentUser()`) and pass it as
the first argument of the use case; use cases never read context themselves. The
rules live in the domain (`House.assertManageableBy`, `Booking.isVisibleTo`,
`bookingScopeFor`, `User.isVisibleTo`), so a second transport cannot bypass them.
Verified actors are branded types: production code cannot build one from request
fields. Rules:
- If the caller may not know that a resource exists, the answer is `NOT_FOUND`, with
  the same reason and message as for a missing one (bookings, users, the template's
  items). If the resource is visible (the public house catalogue) but the action is
  not allowed, the answer is `PERMISSION_DENIED`.
- Lists never fail because of what the caller cannot see: repositories take a typed
  scope (`BookingScope`) and return only what it covers. Only asking for a scope the
  caller may not have is refused (a non-admin listing bookings `as=any` gets 403). Page
  tokens are bound to the caller and the scope.
- Facts a check needs from another service are snapshotted when they are immutable:
  bookings store the house owner as `host_id` (houses never change owner; a future
  transfer must publish an event that updates the snapshots, ADR-0005).

| Operation                                     | Rule                                                  |
| --------------------------------------------- | ----------------------------------------------------- |
| register / resolve                            | the login itself                                      |
| get / rename / delete a user (`/v1/users/me`) | self or admin, else 404; ListUsers admin only         |
| list a house                                  | any user; the caller becomes the owner                |
| read houses                                   | public                                                |
| change / delete a house                       | owner or admin, else 403 HOUSE_PERMISSION_DENIED      |
| book                                          | any user; the caller is the guest, the owner the host |
| read / cancel a booking                       | guest, host or admin, else 404                        |
| list bookings (`?as=guest\|host\|any`)        | own as guest or host; `any` for admins (else 403)     |

### 6. Guardrails

- `pnpm lint` runs `tools/check-access.ts`, which reads the code with the TypeScript 7
  checker (`typescript/unstable/sync`), so names resolve through imports, renames,
  namespaces and type aliases. Every endpoint that does not need a signed-in user
  (public, registration, identity and workload-only methods) is listed with its reason in
  `security/public-endpoints.json`. The access decorators may appear only as decorators
  written on a method or class with inline literal arguments; any other use of them or
  of their metadata (`SetMetadata`, `Reflect`, the key strings) fails. Outside the kit
  nothing may produce a value whose type carries the actor brand: no type assertion or
  type predicate to a type that is or holds an actor, to `never` or to a type built from
  a type parameter; no actor object literal (spread, computed key); no call or property
  read that returns an actor its declaration does not promise (a generic helper,
  `structuredClone`, `Object.assign`, a generic `value!: T`); no definitely-assigned actor
  field; no actor taken by constructor injection, from the request or as a typed callback
  parameter; no overload, ambient declaration or module augmentation of one. Biome and
  oxlint refuse explicit and implicit `any` (member access and calls on it included), and
  check-access refuses `@ts-ignore`-style comments, suppressions of the any-rules and
  non-`.ts` files. No production code builds `x-ga-*` metadata, reaches the test helpers,
  loads a module by a computed path or `createRequire`, or (gateway) touches the raw
  server, Nest middleware or Nest's registries outside its two raw-HTTP files.
  TypeScript is not sound, so these rules list the ways around the brand that reviews
  found; each is a probe in `apps/*/test/access-probes` that check-access checks on every
  run, so a rule that stops working fails lint. `pnpm template:verify` runs the same check
  on a generated service.
- What runs is what the tests check: each service's `AccessPolicyCheck` and the gateway's
  `AuthRoutes` record the policies once at boot (per controller and handler, bound
  methods included), and the guards enforce that record, not live metadata.
  `startTestService` (in a service's own package) and `createTestGateway` fail when the
  recorded open methods or routes differ from the list. Once Fastify is ready,
  `createTestGateway` also fails on any route, hook, plugin, handler or middleware added
  outside the controllers by code other than packages, `bootstrap.ts` and
  `http/openapi.ts`; each registration is attributed to the code that called it, and an
  unknown caller (a call scheduled from a microtask) is refused. The harness's own tests
  show each way it catches.
- What neither sees is code that defeats the type checker at run time (`eval` and the
  like) or edits the guardrails themselves; that is what CODEOWNERS review is for.
  `.github/CODEOWNERS` covers `security/`, the whole service kit, the gateway's auth code,
  its bootstrap, main and OpenAPI files and test harness, the kernel's actor, testing and
  index files, the access check, and everything that decides whether and how the checks
  run: package manifests, tsconfigs, `.swcrc`, `vitest` configs, `turbo.json`,
  `pnpm-workspace.yaml`, Biome and oxlint configs, the workflows and itself.
- The template's gRPC spec starts every new service with five access tests (no user,
  another user, admin, a stranger's empty list, an unlisted forwarder).
- The gateway turns a downstream `UNAUTHENTICATED`, and `PERMISSION_DENIED` with a
  platform reason (`CALLER_NOT_ALLOWED`, `ACCESS_NOT_DECLARED`, ...), into 500: those
  are server bugs, and a 401 would send clients into a sign-in loop.

### Local development

`pnpm stack:up` runs a loopback-only OIDC provider (`tools/dev-idp.ts`, refuses
production) and creates the keys (`pnpm keys`, `pnpm keys --rotate|--prune <workload>`).
`pnpm dev:token <sub> --email ...` prints a token; `pnpm grpc:call <service> <Method>`
calls a service the way the platform does. See `docs/architecture/identity-providers.md`
for adopting a real provider.

## Rejected alternatives

1. **Unsigned `x-principal-id` headers** (this ADR's first draft): anyone who can reach
   a service could impersonate anyone.
2. **Forwarding the IdP token to every service**: every service would depend on the
   IdP, its claim shapes and the identity mapping, with the wrong audience.
3. **One shared HMAC secret**: every service could forge any user.
4. **mTLS or a mesh for identity**: needs infrastructure now; peer certificates break
   behind TLS-terminating proxies. TLS is used for confidentiality; mTLS can be added
   later as defence in depth.
5. **Per-request `aud` = transitive call graph**: couples the gateway to every
   service's dependencies and still lets every service in the closure act as the user.
   Callee-side `via` lists are narrower and reviewed where the method is.
6. **`users.id` = IdP subject or a UUIDv5 of it**: ties the platform to one IdP and
   breaks UUIDv7 ordering.
7. **Roles from IdP claims**: an IdP admin (or a user-writable attribute mapped to the
   claim) would become a platform admin, and claim shapes differ per IdP.
8. **Auto-registration on first login or linking by email**: account squatting and
   takeover.
9. **jose `createRemoteJWKSet` as is**: on an IdP outage it fails every request on the
   request path.
10. **Authorization in the gateway**: it has no data and would race with the services.
11. **Reading the actor from context inside use cases**: invisible to tests, fails open.
12. **OPA/Cedar/OpenFGA, passport, a Keycloak container**: disproportionate for
    ownership rules; jose covers the cryptography.
13. **An `AUTH_DISABLED` or plaintext-in-production switch**: agents would use it.
14. **Removing the request fields that used to carry identities** (`owner_id`,
    `guest_id`, `UpdateUserRequest.email`) and `CreateUser`: breaking. The fields are
    deprecated and ignored (identities come from the principal); `CreateUser` is
    deprecated and admin-only. Both get reserved or removed in a later change
    (deprecate, then reserve).

## Consequences

- Every request costs two Ed25519 verifications per hop and, on a cache miss, one
  `ResolveIdentity` call. The edge stays the only place that talks to the IdP.
- Residual risks: a principal plus a caller key of an allowed forwarder can be replayed
  for up to 60 s; a role change or deletion takes up to `IDENTITY_CACHE_TTL_S` (or the
  stale window during a user-service outage); deleting a user leaves its houses and
  bookings until ADR-0005 cleans them up (implemented 2026-10-23: within seconds).
- Each workload needs one private key in production (a secret) and the shared public
  key map (config). Rotation: publish the new public key, wait until every workload
  logs it (≤ 60 s after the config propagates), switch the private key, prune the old
  public key after 120 s; on compromise remove the old key at once.
- Event consumers (ADR-0005) will call as `@Access.service([...])` with their own
  workload identity; events carry no user principal. (As built: producers and consumers
  call event-bus-service, whose methods are `@Access.service([...])`; a handler acts as
  its own service, `currentService()`.)
- The `host_id` migration was a dev-data-only exception (guarded: it refuses a
  populated table); with real data, such a change is expand -> backfill -> contract.
