import { encodeStatusDetails, STATUS_DETAILS_KEY } from '@ga/contracts/runtime';
import { parseConfig } from '@ga/service-kit';
import { Metadata, status } from '@grpc/grpc-js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ThrottlerException } from '@nestjs/throttler';
import { of, throwError } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { configureGateway, createAdapter } from '../src/bootstrap.ts';
import { BOOKING_SERVICE, HOUSE_SERVICE, USER_SERVICE } from '../src/clients.ts';
import { ConfigSchema } from '../src/config.ts';
import { toProblemDetails } from '../src/http/problem-details.ts';

const USER_ID = '01900000-0000-7000-8000-000000000001';
const user = {
  id: USER_ID,
  email: 'ann@example.com',
  fullName: 'Ann',
  createTime: new Date('2026-01-01T00:00:00.000Z'),
  updateTime: new Date('2026-01-02T00:00:00.000Z'),
};

function grpcError(code: number, message: string, reason?: string) {
  const metadata = new Metadata();
  if (reason) {
    metadata.set(
      STATUS_DETAILS_KEY,
      encodeStatusDetails({
        code,
        message,
        errorInfo: { reason, domain: 'user-service', metadata: { email: 'ann@example.com' } },
      }),
    );
  }
  return Object.assign(new Error(message), { code, details: message, metadata });
}

const users = {
  createUser: vi.fn(),
  getUser: vi.fn(),
  listUsers: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
};

describe('gateway (REST -> gRPC)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    Object.assign(process.env, {
      LOG_LEVEL: 'silent',
      TLS_ENABLED: 'false',
      USER_SERVICE_URL: '127.0.0.1:1',
      HOUSE_SERVICE_URL: '127.0.0.1:1',
      BOOKING_SERVICE_URL: '127.0.0.1:1',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(USER_SERVICE)
      .useValue(users)
      .overrideProvider(HOUSE_SERVICE)
      .useValue({})
      .overrideProvider(BOOKING_SERVICE)
      .useValue({})
      .compile();
    const config = parseConfig(ConfigSchema);
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(config));
    configureGateway(app, config);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => vi.resetAllMocks());

  const inject = (options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    payload?: object;
    headers?: Record<string, string>;
  }) => app.getHttpAdapter().getInstance().inject(options);

  it('creates a user: 201, Location, REST field names, ISO timestamps', async () => {
    users.createUser.mockReturnValue(of({ user }));
    const response = await inject({
      method: 'POST',
      url: '/v1/users',
      payload: { email: 'ann@example.com', fullName: 'Ann' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`/v1/users/${USER_ID}`);
    expect(response.json()).toEqual({
      id: USER_ID,
      email: 'ann@example.com',
      fullName: 'Ann',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(users.createUser).toHaveBeenCalledWith({ email: 'ann@example.com', fullName: 'Ann' });
  });

  it('rejects invalid input with 400 problem+json before calling the service', async () => {
    const response = await inject({
      method: 'POST',
      url: '/v1/users',
      payload: { email: 'nope', fullName: '' },
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
    expect(problem.errors.map((e: { field: string }) => e.field)).toEqual(['email', 'fullName']);
    expect(users.createUser).not.toHaveBeenCalled();
  });

  it('maps a rich gRPC error to a 409 problem with the domain reason', async () => {
    users.createUser.mockReturnValue(
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
      payload: { email: 'ann@example.com', fullName: 'Ann' },
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
    const response = await inject({ method: 'GET', url: `/v1/users/${USER_ID}` });
    expect(response.statusCode).toBe(503);
    const problem = response.json();
    expect(problem.code).toBe('UNAVAILABLE');
    expect(problem.detail).toBeUndefined();
  });

  it('validates path params, pages lists and maps empty tokens to null', async () => {
    expect((await inject({ method: 'GET', url: '/v1/users/not-a-uuid' })).statusCode).toBe(400);
    users.listUsers.mockReturnValue(of({ users: [user], nextPageToken: '' }));
    const response = await inject({ method: 'GET', url: '/v1/users?pageSize=5' });
    expect(response.json()).toMatchObject({ items: [{ id: USER_ID }], nextPageToken: null });
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
  });

  it('returns problem+json for unknown routes', async () => {
    const response = await inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('publishes an OpenAPI document built from the Zod schemas', async () => {
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
    const body = document.paths['/v1/users'].post.requestBody.content['application/json'].schema;
    expect(body).toEqual({ $ref: '#/components/schemas/CreateUserBody' });
    expect(document.components.schemas.CreateUserBody.properties.email).toMatchObject({
      type: 'string',
      format: 'email',
    });
    expect(document.components.schemas).toHaveProperty('ProblemDetails');
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
