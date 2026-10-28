import { Server, ServerCredentials } from '@grpc/grpc-js';
import { HealthImplementation } from 'grpc-health-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestGateway, type TestGateway } from './harness.ts';

/** /readyz against a real grpc.health.v1 server that stands in for all three services. */
describe('gateway readiness', () => {
  const health = new HealthImplementation({ '': 'NOT_SERVING' });
  const server = new Server();
  let gateway: TestGateway;

  beforeAll(async () => {
    health.addToServer(server);
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) =>
        error ? reject(error) : resolve(bound),
      ),
    );
    const url = `127.0.0.1:${port}`;
    gateway = await createTestGateway(new Map(), {
      env: { USER_SERVICE_URL: url, HOUSE_SERVICE_URL: url, BOOKING_SERVICE_URL: url },
    });
  });

  afterAll(async () => {
    await gateway?.close();
    server.forceShutdown();
  });

  const readyz = () => gateway.inject({ method: 'GET', url: '/readyz' });

  it('is not ready until every service has answered SERVING once', async () => {
    const response = await readyz();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'starting',
      dependencies: { 'user-service': 'NOT_SERVING' },
    });
  });

  it('becomes ready, then stays ready and reports degraded when a service goes down', async () => {
    health.setStatus('', 'SERVING');
    const ready = await readyz();
    expect(ready.statusCode).toBe(200);
    expect(ready.json().dependencies).toEqual({
      'user-service': 'SERVING',
      'house-service': 'SERVING',
      'booking-service': 'SERVING',
    });
    health.setStatus('', 'NOT_SERVING');
    const degraded = await readyz();
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toMatchObject({
      status: 'degraded',
      dependencies: { 'booking-service': 'NOT_SERVING' },
    });
  });
});
