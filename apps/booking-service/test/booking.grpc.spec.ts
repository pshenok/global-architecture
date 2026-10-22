import { fileURLToPath } from 'node:url';
import type { BookingServiceClient } from '@ga/contracts/ga/booking/v1/booking';
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
import { HouseCatalog } from '../src/application/ports/house-catalog.ts';
import { UserDirectory } from '../src/application/ports/user-directory.ts';
import { SERVICE } from '../src/service.ts';
import { day, FakeHouseCatalog, FakeUserDirectory, GUEST_ID, HOUSE_ID } from './fakes.ts';

/** Real gRPC + Postgres (with the exclusion constraint); user/house services are fakes behind their ports. */
describe('BookingService over gRPC', () => {
  let db: TestDatabase;
  let service: TestService;
  let client: GrpcTestClient<BookingServiceClient>;
  const request = (from: number, to: number, guests = 2) => ({
    houseId: HOUSE_ID,
    guestId: GUEST_ID,
    checkIn: day(from),
    checkOut: day(to),
    guests,
  });

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
          .useValue(new FakeHouseCatalog()),
    });
    client = createGrpcTestClient<BookingServiceClient>(
      'ga.booking.v1.BookingService',
      SERVICE.protoFiles,
      service.url,
    );
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('bookings'));

  it('confirms a booking with the frozen total price', async () => {
    const { booking } = await client.createBooking(request(10, 13));
    expect(booking).toMatchObject({
      status: 'BOOKING_STATUS_CONFIRMED',
      totalPrice: { currencyCode: 'USD', amountMinor: 30_000 },
      checkIn: day(10),
      checkOut: day(13),
      cancelTime: null,
    });
  });

  it('lets exactly one of many concurrent overlapping requests win', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => client.createBooking(request(20 + (i % 2), 23))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected')
        expect((result.reason as { code: number }).code).toBe(status.ALREADY_EXISTS);
    }
  });

  it('returns ALREADY_EXISTS with BOOKING_DATES_UNAVAILABLE, allows back-to-back, frees dates on cancel', async () => {
    const { booking } = await client.createBooking(request(10, 13));
    const overlap = await grpcError(client.createBooking(request(12, 14)));
    expect(overlap.code).toBe(status.ALREADY_EXISTS);
    expect(overlap.details?.errorInfo?.reason).toBe('BOOKING_DATES_UNAVAILABLE');

    await expect(client.createBooking(request(13, 15))).resolves.toBeDefined();

    const cancelled = await client.cancelBooking({ id: booking?.id as string });
    expect(cancelled.booking).toMatchObject({ status: 'BOOKING_STATUS_CANCELLED' });
    expect(cancelled.booking?.cancelTime).toBeInstanceOf(Date);
    await expect(client.createBooking(request(10, 13))).resolves.toBeDefined();

    const again = await grpcError(client.cancelBooking({ id: booking?.id as string }));
    expect(again.code).toBe(status.FAILED_PRECONDITION);
  });

  it('maps business rule failures to FAILED_PRECONDITION and bad input to INVALID_ARGUMENT', async () => {
    const crowded = await grpcError(client.createBooking(request(10, 12, 5)));
    expect(crowded).toMatchObject({ code: status.FAILED_PRECONDITION });
    expect(crowded.details?.errorInfo?.reason).toBe('BOOKING_TOO_MANY_GUESTS');

    const unknownHouse = await grpcError(
      client.createBooking({ ...request(10, 12), houseId: '01900000-0000-7000-8000-0000000000ff' }),
    );
    expect(unknownHouse.details?.errorInfo?.reason).toBe('BOOKING_HOUSE_NOT_FOUND');

    const badDate = await grpcError(
      client.createBooking({ ...request(10, 12), checkIn: '2026-02-30' }),
    );
    expect(badDate.code).toBe(status.INVALID_ARGUMENT);
    expect(badDate.details?.fieldViolations?.[0]?.field).toBe('checkIn');
  });

  it('filters by guest and house', async () => {
    await client.createBooking(request(10, 11));
    await client.createBooking(request(11, 12));
    const mine = await client.listBookings({ pageSize: 10, pageToken: '', guestId: GUEST_ID });
    expect(mine.bookings).toHaveLength(2);
    const none = await client.listBookings({
      pageSize: 10,
      pageToken: '',
      houseId: '01900000-0000-7000-8000-0000000000ff',
    });
    expect(none.bookings).toHaveLength(0);
  });
});
