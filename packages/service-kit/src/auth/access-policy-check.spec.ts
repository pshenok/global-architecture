import {
  type UserServiceClient,
  type UserServiceController,
  UserServiceControllerMethods,
} from '@ga/contracts/ga/user/v1/user';
import { Controller, Module } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { grpcServiceConfigSchema } from '../config/config.ts';
import { GrpcPlatformModule } from '../platform/grpc-platform.module.ts';
import { defineService } from '../platform/service-definition.ts';
import { grpcError } from '../testing/grpc-test-client.ts';
import { startTestService } from '../testing/start-test-service.ts';
import { ACCESS_POLICY, Access } from './access.ts';
import { AccessPolicyCheck } from './access-policy-check.ts';

const SERVICE = defineService({
  name: 'user-service',
  protoFiles: ['ga/user/v1/user.proto'],
  packages: ['ga.user.v1'],
  services: ['ga.user.v1.UserService'],
});

const empty = () => ({ user: null });

@Controller()
@UserServiceControllerMethods()
class ForgetfulController implements UserServiceController {
  @Access.public('test')
  createUser() {
    return empty();
  }

  /** No @Access: the service must refuse to start. */
  getUser() {
    return empty();
  }

  @Access.public('test')
  registerUser() {
    return empty();
  }

  @Access.public('test')
  resolveIdentity() {
    return { userId: '', roles: [] };
  }

  @Access.public('test')
  listUsers() {
    return { users: [], nextPageToken: '' };
  }

  @Access.public('test')
  updateUser() {
    return empty();
  }

  @Access.public('test')
  deleteUser() {
    return {};
  }
}

@Controller()
@UserServiceControllerMethods()
class ClassLevelController implements UserServiceController {
  createUser() {
    return empty();
  }

  getUser() {
    return empty();
  }

  listUsers() {
    return { users: [], nextPageToken: '' };
  }

  registerUser() {
    return empty();
  }

  resolveIdentity() {
    return { userId: '', roles: [] };
  }

  updateUser() {
    return empty();
  }

  deleteUser() {
    return {};
  }
}
Reflect.defineMetadata(
  ACCESS_POLICY,
  { kind: 'public', reason: 'everything' },
  ClassLevelController,
);

@Controller()
@UserServiceControllerMethods()
class GuardedController implements UserServiceController {
  @Access.user()
  createUser() {
    return empty();
  }

  @Access.user()
  getUser() {
    return empty();
  }

  @Access.identity()
  registerUser() {
    return empty();
  }

  @Access.service(['house-service'])
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

const moduleWith = (controller: new (...args: never[]) => unknown) => {
  @Module({
    imports: [
      GrpcPlatformModule.forRoot({
        service: SERVICE,
        config: grpcServiceConfigSchema,
        database: false,
      }),
    ],
    controllers: [controller],
  })
  class TestModule {}
  return TestModule;
};

describe('@Access boot check', () => {
  it('refuses to start a service with an undeclared gRPC method', async () => {
    await expect(
      startTestService({ module: moduleWith(ForgetfulController), service: SERVICE }),
    ).rejects.toThrow('gRPC methods without an @Access policy: ForgetfulController.getUser');
  });

  it('refuses a policy on a class', async () => {
    await expect(
      startTestService({ module: moduleWith(ClassLevelController), service: SERVICE }),
    ).rejects.toThrow('@Access must be on methods, not on ClassLevelController');
  });

  it('records the open methods and enforces the policies it read at boot', async () => {
    const service = await startTestService({
      module: moduleWith(GuardedController),
      service: SERVICE,
    });
    const handler = GuardedController.prototype.getUser as object;
    try {
      expect(service.app.get(AccessPolicyCheck).open).toEqual([
        {
          member: 'GuardedController.registerUser',
          access: 'identity',
          reason: 'login without a user',
        },
        {
          member: 'GuardedController.resolveIdentity',
          access: 'service',
          reason: 'workloads: house-service',
        },
      ]);
      // Metadata rewritten after boot changes nothing: getUser still needs a user.
      Reflect.deleteMetadata(ACCESS_POLICY, handler);
      Reflect.defineMetadata(ACCESS_POLICY, { kind: 'public', reason: 'late' }, handler);
      const users = service.client<UserServiceClient>('ga.user.v1.UserService');
      const error = await grpcError(users.getUser({ id: 'x' }));
      users.close();
      expect(error.details?.errorInfo?.reason).toBe('PRINCIPAL_MISSING');
    } finally {
      Reflect.deleteMetadata(ACCESS_POLICY, handler);
      await service.close();
    }
  });

  it('rejects policies that cannot work', () => {
    expect(() => Access.public('  ')).toThrow(/reason/);
    expect(() => Access.service([])).toThrow(/at least one caller/);
    expect(() => Access.user({ via: ['Booking Service'] })).toThrow(/not a workload name/);
    class Twice {
      @Access.public('a')
      method() {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      Twice.prototype,
      'method',
    ) as PropertyDescriptor;
    expect(() => Access.user()(Twice.prototype, 'method', descriptor)).toThrow(/more than one/);
  });
});
