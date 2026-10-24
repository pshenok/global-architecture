import { fileURLToPath } from 'node:url';
import type { UserServiceClient } from '@ga/contracts/ga/user/v1/user';
import {
  createTestDatabase,
  EventBusClient,
  FakeEventBus,
  flushOutbox,
  type GrpcTestClient,
  grpcError,
  recordedEvents,
  startTestService,
  type TestDatabase,
  type TestService,
} from '@ga/service-kit/testing';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { USER_DELETED } from '../src/infrastructure/events/outbox-user-events.ts';
import { SERVICE } from '../src/service.ts';

/** UserDeletedEvent is recorded with the delete and handed to the bus (ADR-0005). */
describe('user events', () => {
  const bus = new FakeEventBus();
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
      override: (builder) => builder.overrideProvider(EventBusClient).useValue(bus),
    });
    client = service.client<UserServiceClient>('ga.user.v1.UserService');
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(async () => {
    await db.truncate('users', 'outbox');
    bus.published.length = 0;
  });

  const register = async (subject: string) =>
    (
      await client.registerUser(
        { fullName: subject },
        await service.asIdentity({ issuer: 'https://idp.example', subject }),
      )
    ).user?.id as string;

  it('records UserDeletedEvent with the delete, with nothing but the id', async () => {
    const id = await register('ann');
    await client.deleteUser({ id }, await service.as(id));
    expect(await recordedEvents(db.pool, USER_DELETED)).toEqual([
      {
        id: expect.any(String),
        aggregateId: id,
        payload: { userId: id },
        requestId: expect.any(String),
      },
    ]);
    expect(await flushOutbox(service.app)).toBe(1);
    expect(bus.published).toMatchObject([{ type: 'ga.user.v1.UserDeletedEvent', aggregateId: id }]);
    expect(await recordedEvents(db.pool, USER_DELETED)).toEqual([]);
  });

  it('records nothing when the delete is refused', async () => {
    const id = await register('ann');
    const stranger = await register('bob');
    const error = await grpcError(client.deleteUser({ id }, await service.as(stranger)));
    expect(error.code).toBe(status.NOT_FOUND);
    expect(await recordedEvents(db.pool, USER_DELETED)).toEqual([]);
  });
});
