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
    });
    client = service.client<UserServiceClient>('ga.user.v1.UserService');
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('users'));

  it('registers, reads, updates and deletes a user', async () => {
    const { user } = await client.createUser({ email: 'Ann@Example.com', fullName: 'Ann' });
    expect(user).toMatchObject({ email: 'ann@example.com', fullName: 'Ann' });
    const id = user?.id as string;
    expect(id).toMatch(/^[0-9a-f-]{8}-[0-9a-f]{4}-7/);

    const updated = await client.updateUser({ id, fullName: 'Ann Lee' });
    expect(updated.user).toMatchObject({ email: 'ann@example.com', fullName: 'Ann Lee' });

    await client.deleteUser({ id });
    expect((await grpcError(client.getUser({ id }))).code).toBe(status.NOT_FOUND);
  });

  it('returns ALREADY_EXISTS with reason USER_EMAIL_TAKEN for a duplicate email', async () => {
    await client.createUser({ email: 'ann@example.com', fullName: 'Ann' });
    const error = await grpcError(
      client.createUser({ email: 'ANN@example.com', fullName: 'Other' }),
    );
    expect(error.code).toBe(status.ALREADY_EXISTS);
    expect(error.details?.errorInfo).toMatchObject({
      reason: 'USER_EMAIL_TAKEN',
      domain: 'user-service',
    });
  });

  it('returns INVALID_ARGUMENT with field violations', async () => {
    const error = await grpcError(client.createUser({ email: 'nope', fullName: '' }));
    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details?.fieldViolations?.map((v) => v.field)).toEqual(['email', 'fullName']);
  });

  it('keeps concurrent registrations of one email race-free', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        client.createUser({ email: 'race@example.com', fullName: 'Racer' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(
      rejected.every((r) => (r.reason as { code: number }).code === status.ALREADY_EXISTS),
    ).toBe(true);
  });

  it('pages newest first with opaque tokens', async () => {
    for (const n of ['a', 'b', 'c']) await client.createUser({ email: `${n}@x.io`, fullName: n });
    const first = await client.listUsers({ pageSize: 2, pageToken: '' });
    expect(first.users.map((u) => u.fullName)).toEqual(['c', 'b']);
    const second = await client.listUsers({ pageSize: 2, pageToken: first.nextPageToken });
    expect(second.users.map((u) => u.fullName)).toEqual(['a']);
    expect(second.nextPageToken).toBe('');
  });

  describe('registration (identity principals)', () => {
    const issuer = 'https://idp.example';

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
        client.registerUser({ fullName: 'X' }, await service.as(USER_ID)),
        client.resolveIdentity({}, await service.as(USER_ID)),
      ]) {
        const error = await grpcError(call);
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
