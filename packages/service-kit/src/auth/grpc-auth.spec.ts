import type {
  GetHouseRequest,
  HouseServiceClient,
  HouseServiceController,
} from '@ga/contracts/ga/house/v1/house';
import { HouseServiceControllerMethods } from '@ga/contracts/ga/house/v1/house';
import {
  type GetUserRequest,
  type UserServiceClient,
  type UserServiceController,
  UserServiceControllerMethods,
} from '@ga/contracts/ga/user/v1/user';
import { Metadata, status } from '@grpc/grpc-js';
import { Controller, Inject, Module } from '@nestjs/common';
import { SignJWT } from 'jose';
import { firstValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grpcServiceConfigSchema, grpcTarget } from '../config/config.ts';
import { GrpcClientsModule } from '../grpc/grpc-clients.module.ts';
import { GrpcPlatformModule } from '../platform/grpc-platform.module.ts';
import { defineService } from '../platform/service-definition.ts';
import { type GrpcTestClient, grpcError } from '../testing/grpc-test-client.ts';
import { startTestService, type TestService } from '../testing/start-test-service.ts';
import { Access } from './access.ts';
import { currentActor, currentCaller } from './principal-context.ts';
import { CALLER_METADATA_KEY, PRINCIPAL_METADATA_KEY, PRINCIPAL_TOKEN_TYPE } from './tokens.ts';

const USER = '01900000-0000-7000-8000-000000000001';
const ADMIN = '01900000-0000-7000-8000-00000000000a';

/** Echoes who the guard let in: fullName = actor, email = caller@test. */
const echo = (id: string) => {
  const actor = currentActor();
  const who =
    actor.kind === 'user'
      ? `user:${actor.userId}:${actor.roles.join('+')}`
      : actor.kind === 'identity'
        ? `identity:${actor.subject}`
        : actor.kind;
  return {
    user: {
      id,
      email: `${currentCaller()}@test`,
      fullName: who,
      createTime: new Date(),
      updateTime: new Date(),
    },
  };
};

const INNER = defineService({
  name: 'user-service',
  protoFiles: ['ga/user/v1/user.proto'],
  packages: ['ga.user.v1'],
  services: ['ga.user.v1.UserService'],
});

@Controller()
@UserServiceControllerMethods()
class InnerController implements UserServiceController {
  @Access.user({ via: ['house-service'] })
  getUser(request: GetUserRequest) {
    return echo(request.id);
  }

  @Access.admin()
  listUsers() {
    return { users: [echo('list').user], nextPageToken: '' };
  }

  @Access.identity()
  createUser() {
    return echo('created');
  }

  @Access.service(['house-service'])
  updateUser() {
    return echo('updated');
  }

  @Access.public('kit test: world-readable')
  deleteUser() {
    const actor = currentActor();
    if (actor.kind !== 'anonymous') throw new Error('a public method must not see the user');
    return {};
  }
}

@Module({
  imports: [
    GrpcPlatformModule.forRoot({
      service: INNER,
      config: grpcServiceConfigSchema,
      database: false,
    }),
  ],
  controllers: [InnerController],
})
class InnerModule {}

const OUTER = defineService({
  name: 'house-service',
  protoFiles: ['ga/house/v1/house.proto'],
  packages: ['ga.house.v1'],
  services: ['ga.house.v1.HouseService'],
});
const USERS = Symbol('USERS');

/** house-service calls user-service inside its handler: the second hop. */
@Controller()
@HouseServiceControllerMethods()
class OuterController implements HouseServiceController {
  constructor(@Inject(USERS) private readonly users: UserServiceClient) {}

  @Access.user()
  async getHouse(request: GetHouseRequest) {
    // A forged principal at the call site must be replaced by the request's own one.
    const forged = new Metadata();
    forged.set(PRINCIPAL_METADATA_KEY, 'forged');
    forged.set(CALLER_METADATA_KEY, 'forged');
    const { user } = await firstValueFrom(this.users.getUser({ id: request.id }, forged));
    return {
      house: {
        id: request.id,
        ownerId: request.id,
        title: `${user?.fullName} via ${user?.email}`,
        description: '',
        address: { line1: 'x', city: 'x', countryCode: 'UA' },
        nightlyPrice: { currencyCode: 'USD', amountMinor: 1 },
        maxGuests: 1,
        createTime: new Date(),
        updateTime: new Date(),
      },
    };
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
      service: OUTER,
      config: grpcServiceConfigSchema.extend({ USER_SERVICE_URL: grpcTarget() }),
      database: false,
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
  controllers: [OuterController],
})
class OuterModule {}

describe('GrpcAuthGuard', () => {
  let inner: TestService;
  let outer: TestService;
  let users: GrpcTestClient<UserServiceClient>;

  beforeAll(async () => {
    inner = await startTestService({
      module: InnerModule,
      service: INNER,
      callers: ['house-service', 'booking-service'],
    });
    users = inner.client<UserServiceClient>('ga.user.v1.UserService');
  });

  afterAll(async () => {
    users?.close();
    await outer?.close();
    await inner?.close();
  });

  const code = async (call: Promise<unknown>) => {
    const error = await grpcError(call);
    return { code: error.code, reason: error.details?.errorInfo?.reason };
  };

  it('rejects a call without a caller assertion and keeps serving', async () => {
    expect(await code(users.deleteUser({ id: USER }, new Metadata()))).toEqual({
      code: status.UNAUTHENTICATED,
      reason: 'CALLER_MISSING',
    });
    await expect(users.deleteUser({ id: USER })).resolves.toEqual({});
  });

  it('rejects a caller assertion addressed to another service', async () => {
    const metadata = await callerAddressedTo(inner, 'booking-service', 'house-service');
    expect(await code(users.deleteUser({ id: USER }, metadata))).toEqual({
      code: status.UNAUTHENTICATED,
      reason: 'CALLER_INVALID',
    });
  });

  it('rejects expired callers and principals', async () => {
    const now = Math.floor(Date.now() / 1000);
    const gateway = await inner.keys.signingKey('gateway');
    const stale = (typ: string, claims: Record<string, unknown>) =>
      new SignJWT({ iat: now - 200, exp: now - 100, ...claims })
        .setProtectedHeader({ alg: 'EdDSA', kid: gateway.kid, typ })
        .sign(gateway.key);
    const expiredCaller = new Metadata();
    expiredCaller.set(
      CALLER_METADATA_KEY,
      await stale('ga-caller+jwt', { iss: 'gateway', aud: 'user-service' }),
    );
    expect(await code(users.deleteUser({ id: USER }, expiredCaller))).toEqual({
      code: status.UNAUTHENTICATED,
      reason: 'CALLER_EXPIRED',
    });
    const expiredPrincipal = await inner.anonymous();
    expiredPrincipal.set(
      PRINCIPAL_METADATA_KEY,
      await stale(PRINCIPAL_TOKEN_TYPE, {
        iss: 'gateway',
        aud: 'ga-services',
        kind: 'user',
        sub: USER,
        roles: [],
      }),
    );
    expect(await code(users.getUser({ id: USER }, expiredPrincipal))).toEqual({
      code: status.UNAUTHENTICATED,
      reason: 'PRINCIPAL_EXPIRED',
    });
  });

  it('requires a registered user, from an edge or a listed forwarder', async () => {
    const asUser = await users.getUser({ id: USER }, await inner.as(USER));
    expect(asUser.user).toMatchObject({ fullName: `user:${USER}:`, email: 'gateway@test' });
    const forwarded = await users.getUser(
      { id: USER },
      await inner.as(USER, { caller: 'house-service' }),
    );
    expect(forwarded.user?.email).toBe('house-service@test');
    expect(
      await code(users.getUser({ id: USER }, await inner.as(USER, { caller: 'booking-service' }))),
    ).toEqual({
      code: status.PERMISSION_DENIED,
      reason: 'CALLER_NOT_ALLOWED',
    });
    expect(await code(users.getUser({ id: USER }))).toEqual({
      code: status.UNAUTHENTICATED,
      reason: 'PRINCIPAL_MISSING',
    });
    expect(
      await code(
        users.getUser(
          { id: USER },
          await inner.asIdentity({ issuer: 'https://idp', subject: 's1' }),
        ),
      ),
    ).toEqual({ code: status.PERMISSION_DENIED, reason: 'PRINCIPAL_NOT_REGISTERED' });
  });

  it('accepts principals only from edges', async () => {
    const metadata = await inner.anonymous();
    const house = await inner.keys.signingKey('house-service');
    const now = Math.floor(Date.now() / 1000);
    metadata.set(
      PRINCIPAL_METADATA_KEY,
      await new SignJWT({ kind: 'user', sub: ADMIN, roles: ['admin'] })
        .setProtectedHeader({ alg: 'EdDSA', kid: house.kid, typ: PRINCIPAL_TOKEN_TYPE })
        .setIssuer('house-service')
        .setAudience('ga-services')
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(house.key),
    );
    expect(await code(users.listUsers({ pageSize: 0, pageToken: '' }, metadata))).toEqual({
      code: status.UNAUTHENTICATED,
      reason: 'PRINCIPAL_INVALID',
    });
  });

  it('enforces the admin role', async () => {
    expect(
      await code(users.listUsers({ pageSize: 0, pageToken: '' }, await inner.as(USER))),
    ).toEqual({
      code: status.PERMISSION_DENIED,
      reason: 'ADMIN_ROLE_REQUIRED',
    });
    const page = await users.listUsers(
      { pageSize: 0, pageToken: '' },
      await inner.as(ADMIN, { roles: ['admin'] }),
    );
    expect(page.users[0]?.fullName).toBe(`user:${ADMIN}:admin`);
  });

  it('keeps identity methods for unregistered identities', async () => {
    const created = await users.createUser(
      { email: 'x@y.z', fullName: 'X' },
      await inner.asIdentity({ issuer: 'https://idp', subject: 'sub-7' }),
    );
    expect(created.user?.fullName).toBe('identity:sub-7');
    expect(
      await code(users.createUser({ email: 'x@y.z', fullName: 'X' }, await inner.as(USER))),
    ).toEqual({
      code: status.PERMISSION_DENIED,
      reason: 'IDENTITY_PRINCIPAL_REQUIRED',
    });
  });

  it('lets only listed workloads call service methods, as themselves', async () => {
    const updated = await users.updateUser({ id: USER }, await inner.asService('house-service'));
    expect(updated.user).toMatchObject({ fullName: 'service', email: 'house-service@test' });
    expect(
      await code(users.updateUser({ id: USER }, await inner.asService('booking-service'))),
    ).toEqual({
      code: status.PERMISSION_DENIED,
      reason: 'CALLER_NOT_ALLOWED',
    });
  });

  it('hides the user from public methods, even with an invalid principal', async () => {
    await expect(users.deleteUser({ id: USER }, await inner.as(USER))).resolves.toEqual({});
    const garbage = await inner.anonymous();
    garbage.set(PRINCIPAL_METADATA_KEY, 'not-a-token');
    await expect(users.deleteUser({ id: USER }, garbage)).resolves.toEqual({});
  });

  it('forwards the principal and signs a fresh caller assertion on every hop', async () => {
    outer = await startTestService({
      module: OuterModule,
      service: OUTER,
      env: { USER_SERVICE_URL: inner.url },
      keys: inner.keys,
    });
    const houses = outer.client<HouseServiceClient>('ga.house.v1.HouseService');
    try {
      const { house } = await houses.getHouse({ id: USER }, await outer.as(USER));
      expect(house?.title).toBe(`user:${USER}: via house-service@test`);
    } finally {
      houses.close();
    }
  });
});

/** Caller metadata signed by `caller` but addressed to `audience`. */
async function callerAddressedTo(
  service: TestService,
  caller: string,
  audience: string,
): Promise<Metadata> {
  const key = await service.keys.signingKey(caller);
  const now = Math.floor(Date.now() / 1000);
  const metadata = new Metadata();
  metadata.set(
    CALLER_METADATA_KEY,
    await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: key.kid, typ: 'ga-caller+jwt' })
      .setIssuer(caller)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(key.key),
  );
  return metadata;
}
