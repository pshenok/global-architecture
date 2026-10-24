import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { BookingServiceClient } from '@ga/contracts/ga/booking/v1/booking';
import type { HouseDeletedEvent } from '@ga/contracts/ga/house/v1/house_events';
import type { UserDeletedEvent } from '@ga/contracts/ga/user/v1/user_events';
import { defineEvent } from '@ga/service-kit';
import {
  createTestDatabase,
  deliverEvent,
  type GrpcTestClient,
  startTestService,
  type TestDatabase,
  type TestService,
} from '@ga/service-kit/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { HouseCatalog } from '../src/application/ports/house-catalog.ts';
import { UserDirectory } from '../src/application/ports/user-directory.ts';
import { SERVICE } from '../src/service.ts';
import {
  day,
  FakeHouseCatalog,
  FakeUserDirectory,
  GUEST_ID,
  HOST_ID,
  HOUSE_ID,
  TERMS,
} from './fakes.ts';

const HOUSE_DELETED = defineEvent<HouseDeletedEvent>('ga.house.v1.HouseDeletedEvent', {
  producer: 'house-service',
});
const USER_DELETED = defineEvent<UserDeletedEvent>('ga.user.v1.UserDeletedEvent', {
  producer: 'user-service',
});
const OTHER_HOUSE = '01900000-0000-7000-8000-0000000000b2';

/** Bookings follow deleted houses and users (ADR-0005), on real Postgres. */
describe('booking events', () => {
  let db: TestDatabase;
  let service: TestService;
  let client: GrpcTestClient<BookingServiceClient>;

  beforeAll(async () => {
    db = await createTestDatabase({
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    service = await startTestService({
      module: AppModule,
      service: SERVICE,
      env: {
        DATABASE_URL: db.url,
        USER_SERVICE_URL: '127.0.0.1:1',
        HOUSE_SERVICE_URL: '127.0.0.1:1',
      },
      override: (builder) =>
        builder
          .overrideProvider(UserDirectory)
          .useValue(new FakeUserDirectory())
          .overrideProvider(HouseCatalog)
          .useValue(
            new FakeHouseCatalog(
              new Map([
                [HOUSE_ID, TERMS],
                [OTHER_HOUSE, TERMS],
              ]),
            ),
          ),
    });
    client = service.client<BookingServiceClient>('ga.booking.v1.BookingService');
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('bookings', 'processed_events'));

  const book = async (houseId: string, from: number, to: number) =>
    (
      await client.createBooking(
        // oxlint-disable-next-line typescript/no-deprecated -- the generated type requires it until reserved
        { houseId, guestId: '', checkIn: day(from), checkOut: day(to), guests: 1 },
        await service.as(GUEST_ID),
      )
    ).booking?.id as string;
  const statusOf = async (id: string) =>
    (await db.pool.query('select status, cancelled_at from bookings where id = $1', [id]))
      .rows[0] as { status: string; cancelled_at: Date | null };
  /** A stay that checked out today, which the API itself refuses to create. */
  const finishedStay = async () => {
    const id = randomUUID();
    await db.pool.query(
      `insert into bookings (id, house_id, guest_id, host_id, check_in, check_out, guests,
         total_price_minor, currency_code, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 1, 100, 'USD', 'CONFIRMED', now(), now())`,
      [id, HOUSE_ID, GUEST_ID, HOST_ID, day(-3), day(0)],
    );
    return id;
  };

  it("cancels a deleted house's upcoming and ongoing stays, and frees their dates", async () => {
    const upcoming = await book(HOUSE_ID, 10, 12);
    const ongoing = await book(HOUSE_ID, 0, 2);
    const cancelledBefore = await book(HOUSE_ID, 20, 21);
    await client.cancelBooking({ id: cancelledBefore }, await service.as(GUEST_ID));
    const elsewhere = await book(OTHER_HOUSE, 10, 12);
    const finished = await finishedStay();
    const event = { houseId: HOUSE_ID, ownerId: HOST_ID };
    const id = '01900000-0000-7000-8000-00000000e0b1';

    expect(await deliverEvent(service.app, HOUSE_DELETED, event, { id })).toBe('applied');
    for (const cancelled of [upcoming, ongoing]) {
      expect(await statusOf(cancelled)).toMatchObject({
        status: 'CANCELLED',
        cancelled_at: expect.any(Date),
      });
    }
    expect((await statusOf(elsewhere)).status).toBe('CONFIRMED');
    expect((await statusOf(finished)).status).toBe('CONFIRMED');
    const before = await statusOf(cancelledBefore);
    expect(await deliverEvent(service.app, HOUSE_DELETED, event, { id })).toBe('duplicate');
    expect(await statusOf(cancelledBefore)).toEqual(before);
    await expect(book(HOUSE_ID, 10, 12)).resolves.toEqual(expect.any(String));
  });

  it("cancels a deleted guest's stays, but not the stays that user hosts", async () => {
    const booking = await book(HOUSE_ID, 10, 12);
    // Its host's stays go with the host's houses (HouseDeletedEvent), not here.
    expect(await deliverEvent(service.app, USER_DELETED, { userId: HOST_ID })).toBe('applied');
    expect((await statusOf(booking)).status).toBe('CONFIRMED');
    expect(await deliverEvent(service.app, USER_DELETED, { userId: GUEST_ID })).toBe('applied');
    expect((await statusOf(booking)).status).toBe('CANCELLED');
  });
});
