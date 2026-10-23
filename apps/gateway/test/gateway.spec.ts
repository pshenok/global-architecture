import { encodeStatusDetails, STATUS_DETAILS_KEY } from '@ga/contracts/runtime';
import { currentActor, parseConfig } from '@ga/service-kit';
import { Metadata, status } from '@grpc/grpc-js';
import { ThrottlerException } from '@nestjs/throttler';
import { of, Subject, throwError } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOKING_SERVICE, HOUSE_SERVICE, USER_SERVICE } from '../src/clients.ts';
import { ConfigSchema } from '../src/config.ts';
import { toProblemDetails } from '../src/http/problem-details.ts';
import { createTestGateway, type TestGateway } from './harness.ts';

const USER_ID = '01900000-0000-7000-8000-000000000001';
const HOUSE_ID = '01900000-0000-7000-8000-0000000000a1';
const user = {
  id: USER_ID,
  email: 'ann@example.com',
  fullName: 'Ann',
  roles: [],
  createTime: new Date('2026-01-01T00:00:00.000Z'),
  updateTime: new Date('2026-01-02T00:00:00.000Z'),
};
const house = {
  id: HOUSE_ID,
  ownerId: USER_ID,
  title: 'Loft',
  description: '',
  address: { line1: '1 Main', city: 'Odesa', countryCode: 'UA' },
  nightlyPrice: { currencyCode: 'USD', amountMinor: 100 },
  maxGuests: 2,
  createTime: new Date('2026-01-01T00:00:00.000Z'),
  updateTime: new Date('2026-01-01T00:00:00.000Z'),
};

function grpcError(code: number, message: string, reason?: string, domain = 'user-service') {
  const metadata = new Metadata();
  if (reason) {
    metadata.set(
      STATUS_DETAILS_KEY,
      encodeStatusDetails({
        code,
        message,
        errorInfo: { reason, domain, metadata: { email: 'ann@example.com' } },
      }),
    );
  }
  return Object.assign(new Error(message), { code, details: message, metadata });
}

const users = {
  registerUser: vi.fn(),
  resolveIdentity: vi.fn(),
  createUser: vi.fn(),
  getUser: vi.fn(),
  listUsers: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
};
const houses = {
  createHouse: vi.fn(),
  getHouse: vi.fn(),
  listHouses: vi.fn(),
  updateHouse: vi.fn(),
  deleteHouse: vi.fn(),
};

describe('gateway (REST -> gRPC)', () => {
  let gateway: TestGateway;
  let ann: Record<string, string>;

  beforeAll(async () => {
    gateway = await createTestGateway(
      new Map<symbol, unknown>([
        [USER_SERVICE, users],
        [HOUSE_SERVICE, houses],
        [BOOKING_SERVICE, {}],
      ]),
    );
  });

  afterAll(async () => {
    await gateway?.close();
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    ann = await gateway.as(USER_ID);
  });

  const inject: TestGateway['inject'] = (options) => gateway.inject(options);

  describe('authentication', () => {
    it('answers a protected route without a token with 401 and WWW-Authenticate', async () => {
      const response = await inject({ method: 'GET', url: '/v1/users/me' });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer realm="ga"');
      expect(response.json()).toMatchObject({ status: 401, code: 'AUTH_TOKEN_MISSING' });
      expect(users.getUser).not.toHaveBeenCalled();
    });

    it('answers a bad or expired token with 401 invalid_token', async () => {
      for (const [headers, code] of [
        [{ authorization: 'Bearer not.a.jwt' }, 'AUTH_TOKEN_INVALID'],
        [{ authorization: 'Basic YW5uOnB3' }, 'AUTH_TOKEN_INVALID'],
        [await gateway.bearer('ann', { expiresIn: -120 }), 'AUTH_TOKEN_EXPIRED'],
        [await gateway.bearer('ann', { audience: 'some-client' }), 'AUTH_TOKEN_INVALID'],
      ] as const) {
        const response = await inject({ method: 'GET', url: '/v1/users/me', headers });
        expect(response.statusCode).toBe(401);
        expect(response.headers['www-authenticate']).toBe(
          'Bearer realm="ga", error="invalid_token"',
        );
        expect(response.json().code).toBe(code);
      }
    });

    it('requires registration before anything but POST /v1/users', async () => {
      const response = await inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: await gateway.bearer('newcomer'),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('USER_NOT_REGISTERED');
    });

    it('registers a login with the email the identity provider verified', async () => {
      let actor: unknown;
      users.registerUser.mockImplementation(() => {
        actor = currentActor();
        return of({ user });
      });
      const response = await inject({
        method: 'POST',
        url: '/v1/users',
        headers: await gateway.bearer('newcomer', {
          email: 'Ann@Example.com',
          emailVerified: true,
        }),
        payload: { fullName: 'Ann', email: 'someone-else@example.com' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toBe(`/v1/users/${USER_ID}`);
      expect(users.registerUser).toHaveBeenCalledWith({ fullName: 'Ann' });
      expect(actor).toMatchObject({
        kind: 'identity',
        issuer: gateway.issuer.issuer,
        subject: 'newcomer',
        email: 'Ann@Example.com',
      });
    });

    it('refuses to register an unverified email', async () => {
      const response = await inject({
        method: 'POST',
        url: '/v1/users',
        headers: await gateway.bearer('newcomer', { email: 'a@b.io', emailVerified: false }),
        payload: { fullName: 'Ann' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('EMAIL_NOT_VERIFIED');
      expect(users.registerUser).not.toHaveBeenCalled();
    });

    it('serves the catalogue anonymously, but never with a bad token', async () => {
      houses.listHouses.mockReturnValue(of({ houses: [house], nextPageToken: '' }));
      const anonymous = await inject({ method: 'GET', url: '/v1/houses' });
      expect(anonymous.statusCode).toBe(200);
      const bad = await inject({
        method: 'GET',
        url: '/v1/houses',
        headers: { authorization: 'Bearer forged.token.value' },
      });
      expect(bad.statusCode).toBe(401);
    });

    it('keeps public routes and probes up during an IdP outage; new keys get 503', async () => {
      houses.listHouses.mockReturnValue(of({ houses: [house], nextPageToken: '' }));
      gateway.issuer.setDown(true);
      try {
        await gateway.issuer.rotate(); // tokens now carry a kid the gateway has not fetched
        const headers = await gateway.bearer('login-during-outage');
        const catalogue = await inject({ method: 'GET', url: '/v1/houses', headers });
        expect(catalogue.statusCode).toBe(200);
        const me = await inject({ method: 'GET', url: '/v1/users/me', headers });
        expect(me.statusCode).toBe(503);
        expect(me.json().code).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
        for (const url of ['/healthz', '/readyz']) {
          const probe = await inject({
            method: 'GET',
            url,
            headers: { authorization: 'Basic not-even-bearer' },
          });
          expect(probe.statusCode).not.toBe(401);
        }
      } finally {
        gateway.issuer.setDown(false);
      }
    });

    it('acts as the signed-in user: owner and guest never come from the body', async () => {
      let actor: unknown;
      houses.createHouse.mockImplementation(() => {
        actor = currentActor();
        return of({ house });
      });
      const response = await inject({
        method: 'POST',
        url: '/v1/houses',
        headers: ann,
        payload: {
          ownerId: '01900000-0000-7000-8000-0000000000ff',
          title: 'Loft',
          address: house.address,
          nightlyPrice: house.nightlyPrice,
          maxGuests: 2,
        },
      });
      expect(response.statusCode).toBe(201);
      // The body's ownerId is dropped; house-service takes the owner from the principal.
      expect(houses.createHouse).toHaveBeenCalledWith(expect.objectContaining({ ownerId: '' }));
      expect(actor).toMatchObject({ kind: 'user', userId: USER_ID, roles: [] });
    });

    it('resolves `me` to the signed-in user', async () => {
      users.getUser.mockReturnValue(of({ user }));
      const response = await inject({ method: 'GET', url: '/v1/users/me', headers: ann });
      expect(response.statusCode).toBe(200);
      expect(users.getUser).toHaveBeenCalledWith({ id: USER_ID });
    });

    it('turns authentication faults between gateway and services into 500', async () => {
      for (const error of [
        grpcError(status.UNAUTHENTICATED, 'x-ga-caller: token expired', 'CALLER_EXPIRED'),
        grpcError(
          status.PERMISSION_DENIED,
          'workload gateway may not call this',
          'CALLER_NOT_ALLOWED',
        ),
      ]) {
        users.getUser.mockReturnValue(throwError(() => error));
        const response = await inject({ method: 'GET', url: '/v1/users/me', headers: ann });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({ code: 'INTERNAL' });
        expect(response.json().detail).toBeUndefined();
      }
    });

    it('passes real authorization failures through as 403', async () => {
      users.listUsers.mockReturnValue(
        throwError(() =>
          grpcError(
            status.PERMISSION_DENIED,
            'this operation requires the admin role',
            'ADMIN_ROLE_REQUIRED',
          ),
        ),
      );
      const response = await inject({ method: 'GET', url: '/v1/users', headers: ann });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('ADMIN_ROLE_REQUIRED');
    });
  });

  it('rejects invalid input with 400 problem+json before calling the service', async () => {
    const response = await inject({
      method: 'POST',
      url: '/v1/users',
      headers: await gateway.bearer('newcomer', { email: 'a@b.io', emailVerified: true }),
      payload: { fullName: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = response.json();
    expect(problem).toMatchObject({
      status: 400,
      title: 'Bad Request',
      code: 'VALIDATION_FAILED',
      instance: '/v1/users',
    });
    expect(problem.errors.map((e: { field: string }) => e.field)).toEqual(['fullName']);
    expect(users.registerUser).not.toHaveBeenCalled();
  });

  it('maps a rich gRPC error to a 409 problem with the domain reason', async () => {
    users.registerUser.mockReturnValue(
      throwError(() =>
        grpcError(
          status.ALREADY_EXISTS,
          'email ann@example.com is already registered',
          'USER_EMAIL_TAKEN',
        ),
      ),
    );
    const response = await inject({
      method: 'POST',
      url: '/v1/users',
      headers: await gateway.bearer('newcomer', { email: 'ann@example.com', emailVerified: true }),
      payload: { fullName: 'Ann' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'USER_EMAIL_TAKEN',
      domain: 'user-service',
      detail: 'email ann@example.com is already registered',
      metadata: { email: 'ann@example.com' },
    });
  });

  it('hides details of downstream 5xx', async () => {
    users.getUser.mockReturnValue(
      throwError(() => grpcError(status.UNAVAILABLE, 'connect ECONNREFUSED 10.0.0.7:50051')),
    );
    const response = await inject({ method: 'GET', url: `/v1/users/${USER_ID}`, headers: ann });
    expect(response.statusCode).toBe(503);
    const problem = response.json();
    expect(problem.code).toBe('UNAVAILABLE');
    expect(problem.detail).toBeUndefined();
  });

  it('validates path params, pages lists and maps empty tokens to null', async () => {
    const invalid = await inject({ method: 'GET', url: '/v1/users/not-a-uuid', headers: ann });
    expect(invalid.statusCode).toBe(400);
    users.listUsers.mockReturnValue(of({ users: [user], nextPageToken: '' }));
    const response = await inject({ method: 'GET', url: '/v1/users?pageSize=5', headers: ann });
    expect(response.json()).toMatchObject({
      items: [{ id: USER_ID, roles: [] }],
      nextPageToken: null,
    });
    expect(users.listUsers).toHaveBeenCalledWith({ pageSize: 5, pageToken: '' });
  });

  it('echoes x-request-id and sends security headers', async () => {
    const response = await inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'req-abc-123' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('req-abc-123');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("script-src 'self';");
  });

  it('relaxes the CSP for the /docs page only', async () => {
    const docs = await inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-security-policy']).toContain('https://cdn.jsdelivr.net');
    const api = await inject({ method: 'GET', url: '/v1/nope' });
    expect(api.headers['content-security-policy']).not.toContain('cdn.jsdelivr.net');
  });

  it('returns problem+json for unknown routes', async () => {
    const response = await inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('publishes an OpenAPI document with bearer security on every non-public operation', async () => {
    const document = (await inject({ method: 'GET', url: '/openapi.json' })).json();
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/v1/users',
        '/v1/users/{id}',
        '/v1/houses',
        '/v1/bookings',
        '/v1/bookings/{id}/cancel',
      ]),
    );
    expect(document.components.securitySchemes.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(document.security).toEqual([{ bearer: [] }]);
    const body = document.paths['/v1/users'].post.requestBody.content['application/json'].schema;
    expect(body).toEqual({ $ref: '#/components/schemas/RegisterUserBody' });
    const operations = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(
        item as Record<string, { security?: unknown[]; responses: Record<string, unknown> }>,
      ).map(([method, operation]) => ({ id: `${method.toUpperCase()} ${path}`, operation })),
    );
    const open = operations
      .filter(({ operation }) => operation.security?.length === 0)
      .map(({ id }) => id);
    expect(open.sort()).toEqual(['GET /v1/houses', 'GET /v1/houses/{id}']);
    for (const { id, operation } of operations) {
      if (open.includes(id)) continue;
      expect(operation.responses, id).toHaveProperty('401');
      expect(operation.responses, id).toHaveProperty('403');
    }
    expect(JSON.stringify(document)).not.toContain('x-ga-public');
  });
});

describe('identity resolution through user-service', () => {
  let gateway: TestGateway;

  beforeAll(async () => {
    gateway = await createTestGateway(new Map<symbol, unknown>([[USER_SERVICE, users]]), {
      realResolver: true,
      env: {
        IDENTITY_CACHE_TTL_S: '1',
        IDENTITY_CACHE_NEGATIVE_TTL_S: '60',
        IDENTITY_CACHE_STALE_IF_ERROR_S: '60',
      },
    });
  });

  afterAll(async () => {
    await gateway?.close();
  });

  beforeEach(() => vi.resetAllMocks());

  const me = async (sub: string) =>
    gateway.inject({ method: 'GET', url: '/v1/users/me', headers: await gateway.bearer(sub) });

  it('asks user-service once per login and caches the answer', async () => {
    let actor: unknown;
    users.resolveIdentity.mockImplementation(() => {
      actor = currentActor();
      return of({ userId: USER_ID, roles: ['admin', 'unknown-role'] });
    });
    users.getUser.mockReturnValue(of({ user }));
    expect((await me('cached')).statusCode).toBe(200);
    expect((await me('cached')).statusCode).toBe(200);
    expect(users.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(actor).toMatchObject({ kind: 'identity', subject: 'cached', email: null });
  });

  it('remembers "not registered" until this gateway registers the login', async () => {
    users.resolveIdentity.mockReturnValue(
      throwError(() => grpcError(status.NOT_FOUND, 'no user', 'USER_NOT_REGISTERED')),
    );
    expect((await me('late')).json().code).toBe('USER_NOT_REGISTERED');
    expect((await me('late')).json().code).toBe('USER_NOT_REGISTERED');
    expect(users.resolveIdentity).toHaveBeenCalledTimes(1);
    users.registerUser.mockReturnValue(of({ user }));
    const registered = await gateway.inject({
      method: 'POST',
      url: '/v1/users',
      headers: await gateway.bearer('late', { email: 'late@example.com', emailVerified: true }),
      payload: { fullName: 'Late' },
    });
    expect(registered.statusCode).toBe(201);
    users.resolveIdentity.mockReturnValue(of({ userId: USER_ID, roles: [] }));
    users.getUser.mockReturnValue(of({ user }));
    expect((await me('late')).statusCode).toBe(200);
  });

  it('never caches a lookup that raced the registration, nor a deleted user', async () => {
    const lookup = new Subject<never>();
    users.resolveIdentity.mockReturnValueOnce(lookup);
    const before = me('racer');
    await vi.waitFor(() => expect(users.resolveIdentity).toHaveBeenCalledTimes(1));
    users.registerUser.mockReturnValue(of({ user }));
    const registered = await gateway.inject({
      method: 'POST',
      url: '/v1/users',
      headers: await gateway.bearer('racer', { email: 'r@example.com', emailVerified: true }),
      payload: { fullName: 'Racer' },
    });
    expect(registered.statusCode).toBe(201);
    lookup.error(grpcError(status.NOT_FOUND, 'no user', 'USER_NOT_REGISTERED'));
    expect((await before).json().code).toBe('USER_NOT_REGISTERED');
    users.resolveIdentity.mockReturnValue(of({ userId: USER_ID, roles: [] }));
    users.getUser.mockReturnValue(of({ user }));
    expect((await me('racer')).statusCode).toBe(200);

    users.deleteUser.mockReturnValue(of({}));
    const deleted = await gateway.inject({
      method: 'DELETE',
      url: '/v1/users/me',
      headers: await gateway.bearer('racer'),
    });
    expect(deleted.statusCode).toBe(204);
    users.resolveIdentity.mockReturnValue(
      throwError(() => grpcError(status.NOT_FOUND, 'no user', 'USER_NOT_REGISTERED')),
    );
    expect((await me('racer')).json().code).toBe('USER_NOT_REGISTERED');
  });

  it('forgets "not registered" when registration says the login already has a user', async () => {
    users.resolveIdentity.mockReturnValue(
      throwError(() => grpcError(status.NOT_FOUND, 'no user', 'USER_NOT_REGISTERED')),
    );
    expect((await me('elsewhere')).json().code).toBe('USER_NOT_REGISTERED');
    users.registerUser.mockReturnValue(
      throwError(() =>
        grpcError(status.ALREADY_EXISTS, 'already registered', 'USER_ALREADY_REGISTERED'),
      ),
    );
    const again = await gateway.inject({
      method: 'POST',
      url: '/v1/users',
      headers: await gateway.bearer('elsewhere', { email: 'e@example.com', emailVerified: true }),
      payload: { fullName: 'Elsewhere' },
    });
    expect(again.statusCode).toBe(409);
    users.resolveIdentity.mockReturnValue(of({ userId: USER_ID, roles: [] }));
    users.getUser.mockReturnValue(of({ user }));
    expect((await me('elsewhere')).statusCode).toBe(200);
  });

  describe('after a delete', () => {
    const MIXED_ID = '0190aaaa-0000-7000-8000-0000000000a1';
    let cached: TestGateway;

    beforeAll(async () => {
      cached = await createTestGateway(new Map<symbol, unknown>([[USER_SERVICE, users]]), {
        realResolver: true,
        env: { IDENTITY_CACHE_TTL_S: '60' },
      });
    });

    afterAll(async () => {
      await cached?.close();
    });

    const meOn = async (sub: string) =>
      cached.inject({ method: 'GET', url: '/v1/users/me', headers: await cached.bearer(sub) });
    const loggedIn = async (sub: string) => {
      users.resolveIdentity.mockReturnValue(of({ userId: MIXED_ID, roles: [] }));
      users.getUser.mockReturnValue(of({ user: { ...user, id: MIXED_ID } }));
      expect((await meOn(sub)).statusCode).toBe(200);
    };
    const gone = () =>
      users.resolveIdentity.mockReturnValue(
        throwError(() => grpcError(status.NOT_FOUND, 'no user', 'USER_NOT_REGISTERED')),
      );

    it('forgets the user whatever the case of the id in the path', async () => {
      await loggedIn('upper');
      users.deleteUser.mockReturnValue(of({}));
      const deleted = await cached.inject({
        method: 'DELETE',
        url: `/v1/users/${MIXED_ID.toUpperCase()}`,
        headers: await cached.bearer('upper'),
      });
      expect(deleted.statusCode).toBe(204);
      expect(users.deleteUser).toHaveBeenCalledWith({ id: MIXED_ID });
      gone();
      expect((await meOn('upper')).json().code).toBe('USER_NOT_REGISTERED');
    });

    it("leaves another user's logins cached when someone else's delete fails", async () => {
      await loggedIn('victim');
      users.resolveIdentity.mockReturnValue(
        of({ userId: '0190bbbb-0000-7000-8000-0000000000b2', roles: [] }),
      );
      for (const failure of [
        grpcError(status.NOT_FOUND, 'no such user', 'USER_NOT_FOUND'),
        grpcError(status.UNAVAILABLE, 'down'),
      ]) {
        users.deleteUser.mockReturnValue(throwError(() => failure));
        const refused = await cached.inject({
          method: 'DELETE',
          url: `/v1/users/${MIXED_ID}`,
          headers: await cached.bearer('attacker'),
        });
        expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      }
      users.resolveIdentity.mockClear();
      users.getUser.mockReturnValue(of({ user: { ...user, id: MIXED_ID } }));
      expect((await meOn('victim')).statusCode).toBe(200);
      expect(users.resolveIdentity).not.toHaveBeenCalled();
    });

    it('forgets the user when the delete fails after it may have committed', async () => {
      await loggedIn('deadline');
      users.deleteUser.mockReturnValue(
        throwError(() => grpcError(status.DEADLINE_EXCEEDED, 'deadline exceeded')),
      );
      const deleted = await cached.inject({
        method: 'DELETE',
        url: '/v1/users/me',
        headers: await cached.bearer('deadline'),
      });
      expect(deleted.statusCode).toBe(504);
      gone();
      expect((await meOn('deadline')).json().code).toBe('USER_NOT_REGISTERED');
    });
  });

  it('keeps serving known logins while user-service is down, and 503s unknown ones', async () => {
    users.resolveIdentity.mockReturnValue(of({ userId: USER_ID, roles: [] }));
    users.getUser.mockReturnValue(of({ user }));
    expect((await me('steady')).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // past the 1 s TTL
    users.resolveIdentity.mockReturnValue(throwError(() => grpcError(status.UNAVAILABLE, 'down')));
    expect((await me('steady')).statusCode).toBe(200);
    const unknown = await me('stranger');
    expect(unknown.statusCode).toBe(503);
    expect(unknown.json().code).toBe('USER_SERVICE_UNAVAILABLE');
  });
});

describe('gateway config', () => {
  const issuers = (jwksUri: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify([{ issuer: 'https://idp.example', audience: 'ga-api', jwksUri, ...extra }]);
  const env = {
    USER_SERVICE_URL: 'a:1',
    HOUSE_SERVICE_URL: 'b:1',
    BOOKING_SERVICE_URL: 'c:1',
    WORKLOAD_KEY_FILE: '/keys/gateway.jwk.json',
    WORKLOAD_KEYS_FILE: '/keys/workload-keys.json',
    AUTH_ISSUERS: issuers('https://idp.example/jwks.json'),
  };

  it('disables the docs by default in production only', () => {
    expect(parseConfig(ConfigSchema, { ...env, NODE_ENV: 'production' }).DOCS_ENABLED).toBe(false);
    expect(parseConfig(ConfigSchema, { ...env, NODE_ENV: 'development' }).DOCS_ENABLED).toBe(true);
    expect(
      parseConfig(ConfigSchema, { ...env, NODE_ENV: 'production', DOCS_ENABLED: 'true' })
        .DOCS_ENABLED,
    ).toBe(true);
  });

  it('requires https identity providers, except loopback outside production', () => {
    const local = { ...env, AUTH_ISSUERS: issuers('http://127.0.0.1:8090/jwks.json') };
    expect(() => parseConfig(ConfigSchema, { ...local, NODE_ENV: 'development' })).not.toThrow();
    expect(() => parseConfig(ConfigSchema, { ...local, NODE_ENV: 'production' })).toThrow(
      /must use https/,
    );
    const remote = { ...env, AUTH_ISSUERS: issuers('http://idp.example/jwks.json') };
    expect(() => parseConfig(ConfigSchema, remote)).toThrow(/must use https/);
  });

  it('refuses a max-stale window shorter than two refresh intervals', () => {
    expect(() =>
      parseConfig(ConfigSchema, {
        ...env,
        AUTH_JWKS_REFRESH_S: '600',
        AUTH_JWKS_MAX_STALE_S: '900',
      }),
    ).toThrow(/AUTH_JWKS_MAX_STALE_S/);
  });

  it('never accepts symmetric or unsigned algorithms', () => {
    for (const algorithm of ['HS256', 'none']) {
      const config = {
        ...env,
        AUTH_ISSUERS: issuers('https://idp.example/jwks.json', { algorithms: [algorithm] }),
      };
      expect(() => parseConfig(ConfigSchema, config)).toThrow(/AUTH_ISSUERS/);
    }
    expect(() => parseConfig(ConfigSchema, { ...env, AUTH_ISSUERS: 'not json' })).toThrow(
      /JSON array/,
    );
  });
});

describe('toProblemDetails', () => {
  it('maps throttling to 429', () => {
    expect(toProblemDetails(new ThrottlerException(), '/v1/users', 'r1')).toMatchObject({
      status: 429,
      code: 'TOO_MANY_REQUESTS',
    });
  });

  it('never exposes unexpected errors', () => {
    expect(toProblemDetails(new Error('secret'), '/x', 'r1')).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      instance: '/x',
      requestId: 'r1',
      code: 'INTERNAL',
    });
  });
});
