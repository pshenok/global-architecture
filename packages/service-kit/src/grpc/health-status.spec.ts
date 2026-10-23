import { afterAll, describe, expect, it } from 'vitest';
import { defineService } from '../platform/service-definition.ts';
import { checkGrpcHealth, closeHealthClients } from './health-client.ts';
import { HealthStatus } from './health-status.ts';

const SERVICE = defineService({
  name: 'probe-test',
  protoFiles: ['ga/user/v1/user.proto'],
  packages: ['ga.user.v1'],
  services: ['ga.user.v1.UserService'],
});

describe('HealthStatus probe port', () => {
  afterAll(() => closeHealthClients());

  it('serves the health status alone in plaintext and stops with the service', async () => {
    const health = new HealthStatus(SERVICE, {});
    const port = await health.serveProbes('127.0.0.1', 0);
    const target = `127.0.0.1:${port}`;
    expect(await checkGrpcHealth(target)).toBe('NOT_SERVING');
    await health.evaluate();
    expect(await checkGrpcHealth(target)).toBe('SERVING');
    expect(await checkGrpcHealth(target, { service: 'ga.user.v1.UserService' })).toBe('SERVING');
    await health.beforeApplicationShutdown();
    expect(await checkGrpcHealth(target)).toBe('NOT_SERVING');
    health.onApplicationShutdown();
    expect(await checkGrpcHealth(target, { timeoutMs: 300 })).toBe('UNREACHABLE');
  });
});
