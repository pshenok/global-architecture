import type {
  GetHouseRequest,
  HouseServiceClient,
  HouseServiceController,
} from '@ga/contracts/ga/house/v1/house';
import { HouseServiceControllerMethods } from '@ga/contracts/ga/house/v1/house';
import {
  type UserServiceClient,
  type UserServiceController,
  UserServiceControllerMethods,
} from '@ga/contracts/ga/user/v1/user';
import { UnitOfWork } from '@ga/kernel';
import { status } from '@grpc/grpc-js';
import { Controller, Inject, Module } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Access } from '../auth/access.ts';
import { databaseConfigSchema, grpcServiceConfigSchema, grpcTarget } from '../config/config.ts';
import { GrpcPlatformModule } from '../platform/grpc-platform.module.ts';
import { defineService } from '../platform/service-definition.ts';
import { grpcError } from '../testing/grpc-test-client.ts';
import { startTestService, type TestService } from '../testing/start-test-service.ts';
import { DEFAULT_TEST_DATABASE_URL } from '../testing/test-database.ts';
import {
  GrpcClientsModule,
  outboundContextInterceptor,
  RemoteCallInTransactionError,
} from './grpc-clients.module.ts';

const USER = '01900000-0000-7000-8000-000000000001';

/** Calls user-service received; a refused call must never reach it. */
let calls = 0;

const USERS_DEFINITION = defineService({
  name: 'user-service',
  protoFiles: ['ga/user/v1/user.proto'],
  packages: ['ga.user.v1'],
  services: ['ga.user.v1.UserService'],
});

@Controller()
@UserServiceControllerMethods()
class UsersController implements Partial<UserServiceController> {
  @Access.service(['house-service'])
  getUser() {
    calls += 1;
    return { user: null };
  }

  @Access.public('kit test')
  listUsers() {
    return { users: [], nextPageToken: '' };
  }

  @Access.public('kit test')
  createUser() {
    return { user: null };
  }

  @Access.public('kit test')
  registerUser() {
    return { user: null };
  }

  @Access.public('kit test')
  resolveIdentity() {
    return { userId: '', roles: [] };
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
      service: USERS_DEFINITION,
      config: grpcServiceConfigSchema,
      database: false,
    }),
  ],
  controllers: [UsersController],
})
class UsersModule {}

const HOUSES_DEFINITION = defineService({
  name: 'house-service',
  protoFiles: ['ga/house/v1/house.proto'],
  packages: ['ga.house.v1'],
  services: ['ga.house.v1.HouseService'],
});
const USERS = Symbol('USERS');

/** getHouse calls user-service inside a transaction when the id says so. */
@Controller()
@HouseServiceControllerMethods()
class HousesController implements HouseServiceController {
  constructor(
    @Inject(USERS) private readonly users: UserServiceClient,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  @Access.public('kit test')
  async getHouse(request: GetHouseRequest) {
    const call = () => firstValueFrom(this.users.getUser({ id: USER }));
    if (request.id === 'in-transaction') await this.unitOfWork.run(call);
    else await call();
    return { house: null };
  }

  @Access.public('kit test')
  createHouse() {
    return { house: null };
  }

  @Access.public('kit test')
  listHouses() {
    return { houses: [], nextPageToken: '' };
  }

  @Access.public('kit test')
  updateHouse() {
    return { house: null };
  }

  @Access.public('kit test')
  deleteHouse() {
    return {};
  }
}

@Module({
  imports: [
    GrpcPlatformModule.forRoot({
      service: HOUSES_DEFINITION,
      config: grpcServiceConfigSchema
        .extend(databaseConfigSchema.shape)
        .extend({ USER_SERVICE_URL: grpcTarget() }),
    }),
    GrpcClientsModule.register([
      {
        token: USERS,
        service: 'ga.user.v1.UserService',
        target: 'user-service',
        protoFiles: ['ga/user/v1/user.proto'],
        url: (config) => String(config.USER_SERVICE_URL),
      },
    ]),
  ],
  controllers: [HousesController],
})
class HousesModule {}

/** Real Postgres (TEST_DATABASE_URL): the transaction is a real one. */
describe('remote calls inside a transaction (ADR-0002)', () => {
  let users: TestService;
  let houses: TestService;

  beforeAll(async () => {
    users = await startTestService({
      module: UsersModule,
      service: USERS_DEFINITION,
      callers: ['house-service'],
    });
    houses = await startTestService({
      module: HousesModule,
      service: HOUSES_DEFINITION,
      keys: users.keys,
      env: {
        USER_SERVICE_URL: users.url,
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
      },
    });
  });

  afterAll(async () => {
    await houses?.close();
    await users?.close();
  });

  it('refuses the call before anything is sent', async () => {
    const client = houses.client<HouseServiceClient>('ga.house.v1.HouseService');
    try {
      calls = 0;
      const error = await grpcError(client.getHouse({ id: 'in-transaction' }));
      expect(error.code).toBe(status.INTERNAL);
      expect(calls).toBe(0);
      await expect(client.getHouse({ id: 'outside' })).resolves.toEqual({ house: null });
      expect(calls).toBe(1);
    } finally {
      client.close();
    }
  });

  it('throws at interceptor entry, before the next interceptor runs', () => {
    const interceptor = outboundContextInterceptor(
      1000,
      'user-service',
      { callerToken: () => Promise.resolve('token') },
      () => true,
    );
    let reached = false;
    expect(() =>
      interceptor({ method_definition: {} } as never, () => {
        reached = true;
        return undefined as never;
      }),
    ).toThrow(new RemoteCallInTransactionError('user-service'));
    expect(reached).toBe(false);
  });
});
