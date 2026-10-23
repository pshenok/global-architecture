import { setTimeout as sleep } from 'node:timers/promises';
import {
  type CreateUserRequest,
  type GetUserRequest,
  type UserServiceClient,
  type UserServiceController,
  UserServiceControllerMethods,
} from '@ga/contracts/ga/user/v1/user';
import { DependencyUnavailableError, NotFoundError } from '@ga/kernel';

let unavailableCalls = 0;

import { status } from '@grpc/grpc-js';
import { Controller, type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CLS_ID, ClsModule, ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Access } from '../auth/access.ts';
import { workloadIdentityConfigSchema } from '../auth/config.ts';
import { WorkloadIdentityModule } from '../auth/workload-identity.ts';
import { ConfigModule, grpcServiceConfigSchema } from '../config/config.ts';
import { currentRequestId } from '../context/request-context.ts';
import { GrpcPlatformModule } from '../platform/grpc-platform.module.ts';
import { defineService } from '../platform/service-definition.ts';
import { createGrpcTestClient, grpcError } from '../testing/grpc-test-client.ts';
import { startTestService, type TestService } from '../testing/start-test-service.ts';
import { GrpcClientsModule, toDependencyError } from './grpc-clients.module.ts';
import { parseRequest } from './validation.ts';

const SERVICE = defineService({
  name: 'fake-user-service',
  protoFiles: ['ga/user/v1/user.proto'],
  packages: ['ga.user.v1'],
  services: ['ga.user.v1.UserService'],
});

const CreateUserInput = z.object({ email: z.email(), fullName: z.string().min(1) });

@Controller()
@UserServiceControllerMethods()
class FakeUserController implements UserServiceController {
  @Access.public('kit test')
  createUser(request: CreateUserRequest) {
    const input = parseRequest(CreateUserInput, request);
    return {
      user: {
        id: 'u1',
        email: input.email,
        fullName: currentRequestId() ?? 'no-request-id',
        createTime: new Date('2026-01-02T03:04:05.678Z'),
        updateTime: null,
      },
    };
  }

  @Access.public('kit test')
  async getUser(request: GetUserRequest) {
    if (request.id === 'boom') throw new Error('secret internals');
    if (request.id === 'dependency-down') {
      unavailableCalls += 1;
      throw new DependencyUnavailableError(
        'HOUSE_SERVICE_UNAVAILABLE',
        'house-service is unavailable',
      );
    }
    if (request.id === 'slow') {
      await sleep(1_000);
      return { user: null };
    }
    throw new NotFoundError('USER_NOT_FOUND', `user ${request.id} not found`, {
      userId: request.id,
    });
  }

  @Access.public('kit test')
  listUsers() {
    return { users: [], nextPageToken: '' };
  }

  @Access.public('kit test')
  updateUser() {
    return { user: null };
  }

  @Access.public('kit test')
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
  controllers: [FakeUserController],
})
class FakeServiceModule {}

const USERS = Symbol('USERS');
const DEAD = Symbol('DEAD');

@Module({
  imports: [
    ConfigModule.forRoot(
      workloadIdentityConfigSchema.extend({ TARGET: z.string(), DEAD_TARGET: z.string() }),
    ),
    WorkloadIdentityModule.forRoot({ name: 'gateway' }),
    ClsModule.forRoot({ global: true }),
    GrpcClientsModule.register([
      {
        token: USERS,
        service: 'ga.user.v1.UserService',
        target: SERVICE.name,
        protoFiles: ['ga/user/v1/user.proto'],
        url: (c) => String(c.TARGET),
        timeoutMs: 300,
      },
      {
        token: DEAD,
        service: 'ga.user.v1.UserService',
        target: SERVICE.name,
        protoFiles: ['ga/user/v1/user.proto'],
        url: (c) => String(c.DEAD_TARGET),
        timeoutMs: 300,
      },
    ]),
  ],
})
class CallerModule {}

describe('gRPC server bootstrap (in-process)', () => {
  let service: TestService;
  let caller: INestApplicationContext;
  let users: UserServiceClient;
  let dead: UserServiceClient;
  const client = () => service.client<UserServiceClient>('ga.user.v1.UserService');

  beforeAll(async () => {
    service = await startTestService({ module: FakeServiceModule, service: SERVICE });
    process.env.TARGET = service.url;
    process.env.DEAD_TARGET = '127.0.0.1:1';
    Object.assign(process.env, service.keys.env('gateway'));
    caller = await NestFactory.createApplicationContext(CallerModule, { logger: false });
    users = caller.get<UserServiceClient>(USERS);
    dead = caller.get<UserServiceClient>(DEAD);
  });

  afterAll(async () => {
    await caller?.close();
    await service?.close();
  });

  it('serves the contract and round-trips timestamps', async () => {
    const response = await client().createUser({ email: 'a@b.io', fullName: 'Ann' });
    expect(response.user?.email).toBe('a@b.io');
    expect(response.user?.createTime).toEqual(new Date('2026-01-02T03:04:05.678Z'));
    expect(response.user?.updateTime).toBeNull();
  });

  it('maps domain errors to status codes with rich details', async () => {
    const error = await grpcError(client().getUser({ id: '42' }));
    expect(error.code).toBe(status.NOT_FOUND);
    expect(error.message).toBe('user 42 not found');
    expect(error.details?.errorInfo).toEqual({
      reason: 'USER_NOT_FOUND',
      domain: 'fake-user-service',
      metadata: { userId: '42' },
    });
  });

  it('returns INVALID_ARGUMENT with field violations', async () => {
    const error = await grpcError(client().createUser({ email: 'nope', fullName: '' }));
    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details?.fieldViolations?.map((v) => v.field)).toEqual(['email', 'fullName']);
  });

  it('hides unexpected errors behind INTERNAL', async () => {
    const error = await grpcError(client().getUser({ id: 'boom' }));
    expect(error).toMatchObject({ code: status.INTERNAL, message: 'Internal error' });
  });

  it('reports SERVING on grpc.health.v1', async () => {
    const health = createGrpcTestClient<{ check(r: { service: string }): never }>(
      'grpc.health.v1.Health',
      ['grpc/health/v1/health.proto'],
      service.url,
    ) as unknown as { check(r: { service: string }): Promise<{ status: string }> };
    await expect(health.check({ service: '' })).resolves.toEqual({ status: 'SERVING' });
    await expect(health.check({ service: 'ga.user.v1.UserService' })).resolves.toEqual({
      status: 'SERVING',
    });
  });

  it('propagates the caller request id through GrpcClientsModule', async () => {
    const cls = ClsServiceManager.getClsService();
    const response = await cls.run(async () => {
      cls.set(CLS_ID, 'req-123');
      return firstValueFrom(users.createUser({ email: 'c@d.io', fullName: 'Cid' }));
    });
    expect(response.user?.fullName).toBe('req-123');
  });

  it('applies the default deadline to outbound calls', async () => {
    const error = await firstValueFrom(users.getUser({ id: 'slow' })).catch((e: unknown) => e);
    expect((error as { code: number }).code).toBe(status.DEADLINE_EXCEEDED);
  });

  it('does not let callers retry an UNAVAILABLE that the handler already produced', async () => {
    unavailableCalls = 0;
    const error = await firstValueFrom(users.getUser({ id: 'dependency-down' })).catch(
      (e: unknown) => e,
    );
    expect((error as { code: number }).code).toBe(status.UNAVAILABLE);
    expect(unavailableCalls).toBe(1);
  });

  it('turns an unreachable dependency into DependencyUnavailableError', async () => {
    const error = await firstValueFrom(dead.getUser({ id: '1' })).catch((e: unknown) => e);
    expect(toDependencyError(error, 'user-service')).toBeInstanceOf(DependencyUnavailableError);
  });
});
