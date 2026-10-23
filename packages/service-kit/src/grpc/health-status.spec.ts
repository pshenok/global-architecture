import {
  type UserServiceController,
  UserServiceControllerMethods,
} from '@ga/contracts/ga/user/v1/user';
import { Client, credentials, status } from '@grpc/grpc-js';
import { Controller, Module } from '@nestjs/common';
import { afterAll, describe, expect, it } from 'vitest';
import { Access } from '../auth/access.ts';
import { grpcServiceConfigSchema } from '../config/config.ts';
import { GrpcPlatformModule } from '../platform/grpc-platform.module.ts';
import { defineService } from '../platform/service-definition.ts';
import { freePort } from '../testing/free-port.ts';
import { startTestService } from '../testing/start-test-service.ts';
import { checkGrpcHealth, closeHealthClients } from './health-client.ts';
import { HealthStatus } from './health-status.ts';

const SERVICE = defineService({
  name: 'probe-test',
  protoFiles: ['ga/user/v1/user.proto'],
  packages: ['ga.user.v1'],
  services: ['ga.user.v1.UserService'],
});

/** Status of a plaintext call to `path` with an empty message. */
function plaintextCall(target: string, path: string): Promise<number> {
  return new Promise((resolve) => {
    const client = new Client(target, credentials.createInsecure());
    client.makeUnaryRequest(
      path,
      (message: Buffer) => message,
      (message: Buffer) => message,
      Buffer.alloc(0),
      (error) => {
        client.close();
        resolve(error?.code ?? status.OK);
      },
    );
  });
}

const empty = () => ({ user: null });

@Controller()
@UserServiceControllerMethods()
class UsersController implements UserServiceController {
  @Access.user()
  createUser() {
    return empty();
  }

  @Access.user()
  getUser() {
    return empty();
  }

  @Access.user()
  registerUser() {
    return empty();
  }

  @Access.user()
  resolveIdentity() {
    return { userId: '', roles: [] };
  }

  @Access.user()
  listUsers() {
    return { users: [], nextPageToken: '' };
  }

  @Access.user()
  updateUser() {
    return empty();
  }

  @Access.user()
  deleteUser() {
    return {};
  }
}

@Module({
  imports: [
    GrpcPlatformModule.forRoot({
      service: SERVICE,
      config: grpcServiceConfigSchema,
      database: false,
    }),
  ],
  controllers: [UsersController],
})
class ProbeTestModule {}

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

  it('is what a service opens on GRPC_HEALTH_PORT: health only, nothing else', async () => {
    const probePort = await freePort();
    const service = await startTestService({
      module: ProbeTestModule,
      service: SERVICE,
      env: { GRPC_HEALTH_PORT: String(probePort) },
    });
    try {
      const probes = `127.0.0.1:${probePort}`;
      expect(await checkGrpcHealth(probes)).toBe('SERVING');
      expect(await plaintextCall(probes, '/ga.user.v1.UserService/GetUser')).toBe(
        status.UNIMPLEMENTED,
      );
      expect(
        await plaintextCall(probes, '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo'),
      ).toBe(status.UNIMPLEMENTED);
      // The service itself is on its own port, behind the auth guard.
      expect(await plaintextCall(service.url, '/ga.user.v1.UserService/GetUser')).toBe(
        status.UNAUTHENTICATED,
      );
    } finally {
      await service.close();
      delete process.env.GRPC_HEALTH_PORT;
    }
  });

  it('refuses a probe port equal to the gRPC port', async () => {
    const port = String(await freePort());
    try {
      await expect(
        startTestService({
          module: ProbeTestModule,
          service: SERVICE,
          env: { GRPC_PORT: port, GRPC_HEALTH_PORT: port },
        }),
      ).rejects.toThrow('GRPC_HEALTH_PORT must differ from GRPC_PORT');
    } finally {
      delete process.env.GRPC_HEALTH_PORT;
    }
  });
});
