import { fileURLToPath } from 'node:url';
import type { BookingServiceClient } from '@ga/contracts/ga/booking/v1/booking';
import {
  createTestDatabase,
  type GrpcTestClient,
  grpcError,
  startTestService,
  type TestDatabase,
  type TestService,
} from '@ga/service-kit/testing';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { HouseCatalog } from '../src/application/ports/house-catalog.ts';
import { UserDirectory } from '../src/application/ports/user-directory.ts';
import { SERVICE } from '../src/service.ts';
import { day, FakeHouseCatalog, FakeUserDirectory, GUEST_ID, HOUSE_ID } from './fakes.ts';

/**
 * Database errors that no repository wraps (here a statement timeout while waiting for a
 * row lock in SELECT ... FOR UPDATE) still reach the caller with a precise status.
 */
describe('database errors outside repository translation', () => {
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
        DB_STATEMENT_TIMEOUT_MS: '300',
        USER_SERVICE_URL: '127.0.0.1:1',
        HOUSE_SERVICE_URL: '127.0.0.1:1',
      },
      override: (builder) =>
        builder
          .overrideProvider(UserDirectory)
          .useValue(new FakeUserDirectory())
          .overrideProvider(HouseCatalog)
          .useValue(new FakeHouseCatalog()),
    });
    client = service.client<BookingServiceClient>('ga.booking.v1.BookingService');
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  it('answers UNAVAILABLE DATABASE_TIMEOUT when a row lock outlasts the statement timeout', async () => {
    const asGuest = await service.as(GUEST_ID);
    const { booking } = await client.createBooking(
      // oxlint-disable-next-line typescript/no-deprecated -- the generated type requires it until reserved
      { houseId: HOUSE_ID, guestId: '', checkIn: day(10), checkOut: day(12), guests: 1 },
      asGuest,
    );
    const id = booking?.id as string;
    const blocker = await db.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query(`select 1 from "${db.schema}".bookings where id = $1 for update`, [id]);
      const failure = await grpcError(client.cancelBooking({ id }, asGuest));
      expect(failure.code).toBe(status.UNAVAILABLE);
      expect(failure.details?.errorInfo?.reason).toBe('DATABASE_TIMEOUT');
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
    }
    // The lock is gone, so the same cancel now goes through.
    const cancelled = await client.cancelBooking({ id }, asGuest);
    expect(cancelled.booking).toMatchObject({ status: 'BOOKING_STATUS_CANCELLED' });
  });
});
