import { fileURLToPath } from 'node:url';
import type { UserServiceClient } from '@ga/contracts/ga/user/v1/user';
import {
  createGrpcTestClient,
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
    client = createGrpcTestClient<UserServiceClient>(
      'ga.user.v1.UserService',
      SERVICE.protoFiles,
      service.url,
    );
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
});
