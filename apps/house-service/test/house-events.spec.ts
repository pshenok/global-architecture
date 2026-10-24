import { fileURLToPath } from 'node:url';
import type { HouseServiceClient } from '@ga/contracts/ga/house/v1/house';
import type { UserDeletedEvent } from '@ga/contracts/ga/user/v1/user_events';
import { defineEvent } from '@ga/service-kit';
import {
  createTestDatabase,
  deliverEvent,
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
import { UserDirectory } from '../src/application/ports/user-directory.ts';
import { HOUSE_DELETED } from '../src/infrastructure/events/outbox-house-events.ts';
import { SERVICE } from '../src/service.ts';
import { FakeUserDirectory, houseRequest, OWNER_ID } from './fakes.ts';

const USER_DELETED = defineEvent<UserDeletedEvent>('ga.user.v1.UserDeletedEvent', {
  producer: 'user-service',
});
const OTHER_OWNER = '01900000-0000-7000-8000-0000000000bb';

/** HouseDeletedEvent out, UserDeletedEvent in (ADR-0005), on real Postgres. */
describe('house events', () => {
  const users = new FakeUserDirectory(new Set([OWNER_ID, OTHER_OWNER]));
  let db: TestDatabase;
  let service: TestService;
  let client: GrpcTestClient<HouseServiceClient>;

  beforeAll(async () => {
    db = await createTestDatabase({
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    service = await startTestService({
      module: AppModule,
      service: SERVICE,
      env: { DATABASE_URL: db.url, USER_SERVICE_URL: '127.0.0.1:1' },
      override: (builder) => builder.overrideProvider(UserDirectory).useValue(users),
    });
    client = service.client<HouseServiceClient>('ga.house.v1.HouseService');
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('houses', 'outbox', 'processed_events'));

  const listHouse = async (owner: string) =>
    (await client.createHouse(houseRequest(), await service.as(owner))).house?.id as string;

  it('records HouseDeletedEvent when the owner deletes a house, not when a stranger tries', async () => {
    const id = await listHouse(OWNER_ID);
    const error = await grpcError(client.deleteHouse({ id }, await service.as(OTHER_OWNER)));
    expect(error.code).toBe(status.PERMISSION_DENIED);
    expect(await recordedEvents(db.pool, HOUSE_DELETED)).toEqual([]);
    await client.deleteHouse({ id }, await service.as(OWNER_ID));
    expect(await recordedEvents(db.pool, HOUSE_DELETED)).toMatchObject([
      { aggregateId: id, payload: { houseId: id, ownerId: OWNER_ID } },
    ]);
  });

  it("deletes a deleted user's houses once, announcing each, and keeps everyone else's", async () => {
    const first = await listHouse(OWNER_ID);
    const second = await listHouse(OWNER_ID);
    const kept = await listHouse(OTHER_OWNER);
    const event = { userId: OWNER_ID };
    const id = '01900000-0000-7000-8000-00000000e0a1';
    expect(await deliverEvent(service.app, USER_DELETED, event, { id })).toBe('applied');
    expect((await recordedEvents(db.pool, HOUSE_DELETED)).map((e) => e.payload)).toEqual(
      expect.arrayContaining([
        { houseId: first, ownerId: OWNER_ID },
        { houseId: second, ownerId: OWNER_ID },
      ]),
    );
    expect(await deliverEvent(service.app, USER_DELETED, event, { id })).toBe('duplicate');
    expect(await recordedEvents(db.pool, HOUSE_DELETED)).toHaveLength(2);
    const error = await grpcError(client.getHouse({ id: first }));
    expect(error.code).toBe(status.NOT_FOUND);
    await expect(client.getHouse({ id: kept })).resolves.toMatchObject({ house: { id: kept } });
  });

  it('accepts a user without houses, and only from user-service', async () => {
    expect(await deliverEvent(service.app, USER_DELETED, { userId: OTHER_OWNER })).toBe('applied');
    await listHouse(OTHER_OWNER);
    expect(
      await deliverEvent(
        service.app,
        USER_DELETED,
        { userId: OTHER_OWNER },
        { producer: 'booking-service' },
      ),
    ).toMatchObject({ dead: 'UNEXPECTED_PRODUCER' });
    expect(await recordedEvents(db.pool, HOUSE_DELETED)).toEqual([]);
  });
});
