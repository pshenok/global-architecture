import { fileURLToPath } from 'node:url';
import type { UserServiceClient } from '@ga/contracts/ga/user/v1/user';
import {
  createTestDatabase,
  type GrpcTestClient,
  grpcError,
  startTestService,
  type TestDatabase,
  type TestService,
} from '@ga/service-kit/testing';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { SERVICE } from '../src/service.ts';

const USER_ID = '01900000-0000-7000-8000-000000000001';

describe('UserService over gRPC', () => {
  let db: TestDatabase;
  let service: TestService;
  let client: GrpcTestClient<UserServiceClient>;

  beforeAll(async () => {
    db = await createTestDatabase({
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    service = await startTestService({
      module: AppModule,
      service: SERVICE,
      env: { DATABASE_URL: db.url },
      callers: ['house-service', 'booking-service', 'payment-service'],
    });
    client = service.client<UserServiceClient>('ga.user.v1.UserService');
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('users'));

  const ADMIN = '01900000-0000-7000-8000-00000000000a';
  const issuer = 'https://idp.example';
  const register = async (subject: string, email: string | null = null) =>
    (
      await client.registerUser(
        { fullName: subject },
        await service.asIdentity({ issuer, subject, email }),
      )
    ).user?.id as string;

  it('lets a user read, rename and delete itself; the email belongs to the IdP', async () => {
    const id = await register('ann', 'Ann@Example.com');
    expect(id).toMatch(/^[0-9a-f-]{8}-[0-9a-f]{4}-7/);
    const self = await service.as(id);
    await expect(client.getUser({ id }, self)).resolves.toMatchObject({
      user: { email: 'ann@example.com', fullName: 'ann', roles: [] },
    });
    const updated = await client.updateUser(
      // oxlint-disable-next-line typescript/no-deprecated -- proves the deprecated field is ignored
      { id, fullName: 'Ann Lee', email: 'x@evil.example' },
      self,
    );
    expect(updated.user).toMatchObject({ email: 'ann@example.com', fullName: 'Ann Lee' });
    await client.deleteUser({ id }, self);
    expect(
      (await grpcError(client.getUser({ id }, await service.as(ADMIN, { roles: ['admin'] })))).code,
    ).toBe(status.NOT_FOUND);
  });

  it('hides users from other users, and shows them to admins', async () => {
    const id = await register('ann');
    const stranger = await service.as(USER_ID);
    for (const call of [
      async () => client.getUser({ id }, stranger),
      async () => client.updateUser({ id, fullName: 'Hacked' }, stranger),
      async () => client.deleteUser({ id }, stranger),
    ]) {
      const error = await grpcError(call());
      expect(error.code).toBe(status.NOT_FOUND);
      expect(error.details?.errorInfo?.reason).toBe('USER_NOT_FOUND');
    }
    await expect(
      client.getUser({ id }, await service.as(ADMIN, { roles: ['admin'] })),
    ).resolves.toBeDefined();
  });

  it('accepts the acting user forwarded by house-service and booking-service only', async () => {
    const id = await register('host');
    for (const caller of ['house-service', 'booking-service']) {
      await expect(client.getUser({ id }, await service.as(id, { caller }))).resolves.toBeDefined();
    }
    const error = await grpcError(
      client.getUser({ id }, await service.as(id, { caller: 'payment-service' })),
    );
    expect(error).toMatchObject({ code: status.PERMISSION_DENIED });
    expect(error.details?.errorInfo?.reason).toBe('CALLER_NOT_ALLOWED');
  });

  it('pages users newest first for admins only', async () => {
    for (const n of ['a', 'b', 'c']) await register(n);
    const admin = await service.as(ADMIN, { roles: ['admin'] });
    const first = await client.listUsers({ pageSize: 2, pageToken: '' }, admin);
    expect(first.users.map((u) => u.fullName)).toEqual(['c', 'b']);
    const second = await client.listUsers({ pageSize: 2, pageToken: first.nextPageToken }, admin);
    expect(second.users.map((u) => u.fullName)).toEqual(['a']);
    expect(second.nextPageToken).toBe('');
    const denied = await grpcError(
      client.listUsers({ pageSize: 2, pageToken: '' }, await service.as(USER_ID)),
    );
    expect(denied.code).toBe(status.PERMISSION_DENIED);
    expect(denied.details?.errorInfo?.reason).toBe('ADMIN_ROLE_REQUIRED');
  });

  it('keeps the deprecated CreateUser for admins, with its validation and email rule', async () => {
    const admin = await service.as(ADMIN, { roles: ['admin'] });
    await client.createUser({ email: 'ann@example.com', fullName: 'Ann' }, admin);
    const taken = await grpcError(
      client.createUser({ email: 'ANN@example.com', fullName: 'Other' }, admin),
    );
    expect(taken.code).toBe(status.ALREADY_EXISTS);
    expect(taken.details?.errorInfo).toMatchObject({
      reason: 'USER_EMAIL_TAKEN',
      domain: 'user-service',
    });
    const invalid = await grpcError(client.createUser({ email: 'nope', fullName: '' }, admin));
    expect(invalid.code).toBe(status.INVALID_ARGUMENT);
    expect(invalid.details?.fieldViolations?.map((v) => v.field)).toEqual(['email', 'fullName']);
    const denied = await grpcError(
      client.createUser({ email: 'b@example.com', fullName: 'B' }, await service.as(USER_ID)),
    );
    expect(denied.details?.errorInfo?.reason).toBe('ADMIN_ROLE_REQUIRED');
  });

  it('keeps concurrent registrations of one email by different logins race-free', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, async (_, n) => {
        const metadata = await service.asIdentity({
          issuer,
          subject: `racer-${n}`,
          email: 'race@example.com',
        });
        return grpcError(client.registerUser({ fullName: 'Racer' }, metadata)).catch(
          () => 'registered' as const,
        );
      }),
    );
    expect(outcomes.filter((o) => o === 'registered')).toHaveLength(1);
    for (const outcome of outcomes.filter((o) => o !== 'registered')) {
      expect(outcome).toMatchObject({
        code: status.ALREADY_EXISTS,
        details: { errorInfo: { reason: 'USER_EMAIL_TAKEN' } },
      });
    }
  });

  it('returns INVALID_ARGUMENT with field violations', async () => {
    const error = await grpcError(
      client.registerUser({ fullName: '' }, await service.asIdentity({ issuer, subject: 'x' })),
    );
    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details?.fieldViolations?.map((v) => v.field)).toEqual(['fullName']);
  });

  describe('registration (identity principals)', () => {
    it('registers the calling identity and resolves it to its user', async () => {
      const { user } = await client.registerUser(
        { fullName: 'Reg' },
        await service.asIdentity({ issuer, subject: 's1', email: 'Reg@Example.com' }),
      );
      expect(user).toMatchObject({ email: 'reg@example.com', fullName: 'Reg', roles: [] });
      await expect(
        client.resolveIdentity({}, await service.asIdentity({ issuer, subject: 's1' })),
      ).resolves.toEqual({ userId: user?.id, roles: [] });
    });

    it('registers without an email when the identity provider shares none', async () => {
      const { user } = await client.registerUser(
        { fullName: 'No Mail' },
        await service.asIdentity({ issuer, subject: 's2' }),
      );
      expect(user?.email).toBe('');
    });

    it('keeps two issuers with the same subject apart', async () => {
      const a = await client.registerUser(
        { fullName: 'A' },
        await service.asIdentity({ issuer, subject: 'same' }),
      );
      const b = await client.registerUser(
        { fullName: 'B' },
        await service.asIdentity({ issuer: 'https://other.example', subject: 'same' }),
      );
      expect(a.user?.id).not.toBe(b.user?.id);
    });

    it('answers an unknown identity with NOT_FOUND USER_NOT_REGISTERED', async () => {
      const error = await grpcError(
        client.resolveIdentity({}, await service.asIdentity({ issuer, subject: 'nobody' })),
      );
      expect(error.code).toBe(status.NOT_FOUND);
      expect(error.details?.errorInfo?.reason).toBe('USER_NOT_REGISTERED');
    });

    it('accepts only identity principals', async () => {
      for (const call of [
        async () => client.registerUser({ fullName: 'X' }, await service.as(USER_ID)),
        async () => client.resolveIdentity({}, await service.as(USER_ID)),
      ]) {
        const error = await grpcError(call());
        expect(error.code).toBe(status.PERMISSION_DENIED);
        expect(error.details?.errorInfo?.reason).toBe('IDENTITY_PRINCIPAL_REQUIRED');
      }
    });

    it.each([
      ['the same email', () => 'race@example.com'],
      ['different emails', (n: number) => `race${n}@example.com`],
    ])(
      'lets one of five concurrent registrations of an identity win (%s)',
      async (_name, email) => {
        const outcomes = await Promise.all(
          Array.from({ length: 5 }, async (_, n) => {
            const metadata = await service.asIdentity({
              issuer,
              subject: 'racer',
              email: email(n),
            });
            // grpcError throws when the call succeeds: that is the one winner.
            return grpcError(client.registerUser({ fullName: 'Racer' }, metadata)).catch(
              () => 'registered' as const,
            );
          }),
        );
        expect(outcomes.filter((outcome) => outcome === 'registered')).toHaveLength(1);
        for (const outcome of outcomes.filter((o) => o !== 'registered')) {
          expect(outcome).toMatchObject({
            code: status.ALREADY_EXISTS,
            details: { errorInfo: { reason: 'USER_ALREADY_REGISTERED' } },
          });
        }
      },
    );

    it('refuses another identity whose email is taken', async () => {
      await client.registerUser(
        { fullName: 'Ann' },
        await service.asIdentity({ issuer, subject: 'ann', email: 'ann@example.com' }),
      );
      const error = await grpcError(
        client.registerUser(
          { fullName: 'Imposter' },
          await service.asIdentity({ issuer, subject: 'imposter', email: 'ANN@example.com' }),
        ),
      );
      expect(error.code).toBe(status.ALREADY_EXISTS);
      expect(error.details?.errorInfo?.reason).toBe('USER_EMAIL_TAKEN');
    });
  });
});
