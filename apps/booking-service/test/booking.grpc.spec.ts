import { fileURLToPath } from 'node:url';
import { BookingParty, type BookingServiceClient } from '@ga/contracts/ga/booking/v1/booking';
import {
  createTestDatabase,
  type GrpcTestClient,
  grpcError,
  startTestService,
  type TestDatabase,
  type TestService,
} from '@ga/service-kit/testing';
import { Metadata, status } from '@grpc/grpc-js';
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
  STRANGER_ID,
} from './fakes.ts';

/** Real gRPC + Postgres (with the exclusion constraint); user/house services are fakes behind their ports. */
describe('BookingService over gRPC', () => {
  let db: TestDatabase;
  let service: TestService;
  let client: GrpcTestClient<BookingServiceClient>;
  let asGuest: Metadata;
  /** guest_id is deprecated and ignored: the guest is the calling user. */
  const request = (from: number, to: number, guests = 2) => ({
    houseId: HOUSE_ID,
    guestId: '',
    checkIn: day(from),
    checkOut: day(to),
    guests,
  });
  const book = async (from: number, to: number, guests = 2) =>
    client.createBooking(request(from, to, guests), await service.as(GUEST_ID));
  const list = async (
    party: BookingParty,
    metadata: Metadata,
    extra: { pageToken?: string; houseId?: string } = {},
  ) =>
    // oxlint-disable-next-line typescript/no-deprecated -- the generated type requires it until reserved
    client.listBookings({ pageSize: 10, pageToken: '', guestId: '', party, ...extra }, metadata);

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
    client = service.client<BookingServiceClient>('ga.booking.v1.BookingService');
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(async () => {
    await db.truncate('bookings');
    asGuest = await service.as(GUEST_ID);
  });

  it('confirms a booking for the caller with the frozen total price and the host', async () => {
    const { booking } = await client.createBooking(
      // oxlint-disable-next-line typescript/no-deprecated -- proves the deprecated field is ignored
      { ...request(10, 13), guestId: STRANGER_ID },
      asGuest,
    );
    expect(booking).toMatchObject({
      guestId: GUEST_ID,
      hostId: HOST_ID,
      status: 'BOOKING_STATUS_CONFIRMED',
      totalPrice: { currencyCode: 'USD', amountMinor: 30_000 },
      checkIn: day(10),
      checkOut: day(13),
      cancelTime: null,
    });
  });

  it('lets exactly one of many concurrent overlapping requests win', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => client.createBooking(request(20 + (i % 2), 23), asGuest)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected')
        expect((result.reason as { code: number }).code).toBe(status.ALREADY_EXISTS);
    }
  });

  it('returns ALREADY_EXISTS with BOOKING_DATES_UNAVAILABLE, allows back-to-back, frees dates on cancel', async () => {
    const { booking } = await book(10, 13);
    const overlap = await grpcError(book(12, 14));
    expect(overlap.code).toBe(status.ALREADY_EXISTS);
    expect(overlap.details?.errorInfo?.reason).toBe('BOOKING_DATES_UNAVAILABLE');

    await expect(book(13, 15)).resolves.toBeDefined();

    const cancelled = await client.cancelBooking({ id: booking?.id as string }, asGuest);
    expect(cancelled.booking).toMatchObject({ status: 'BOOKING_STATUS_CANCELLED' });
    expect(cancelled.booking?.cancelTime).toBeInstanceOf(Date);
    await expect(book(10, 13)).resolves.toBeDefined();

    const again = await grpcError(client.cancelBooking({ id: booking?.id as string }, asGuest));
    expect(again.code).toBe(status.FAILED_PRECONDITION);
  });

  it('maps business rule failures to FAILED_PRECONDITION and bad input to INVALID_ARGUMENT', async () => {
    const crowded = await grpcError(book(10, 12, 5));
    expect(crowded).toMatchObject({ code: status.FAILED_PRECONDITION });
    expect(crowded.details?.errorInfo?.reason).toBe('BOOKING_TOO_MANY_GUESTS');

    const unknownHouse = await grpcError(
      client.createBooking(
        { ...request(10, 12), houseId: '01900000-0000-7000-8000-0000000000ff' },
        asGuest,
      ),
    );
    expect(unknownHouse.details?.errorInfo?.reason).toBe('BOOKING_HOUSE_NOT_FOUND');

    const badDate = await grpcError(
      client.createBooking({ ...request(10, 12), checkIn: '2026-02-30' }, asGuest),
    );
    expect(badDate.code).toBe(status.INVALID_ARGUMENT);
    expect(badDate.details?.fieldViolations?.[0]?.field).toBe('checkIn');
  });

  describe('access', () => {
    it('needs a signed-in user for every method', async () => {
      const { booking } = await book(10, 11);
      const id = booking?.id as string;
      for (const call of [
        async () => client.createBooking(request(12, 13)),
        async () => client.getBooking({ id }),
        async () =>
          client.listBookings({
            pageSize: 10,
            pageToken: '',
            // oxlint-disable-next-line typescript/no-deprecated -- the generated type requires it until reserved
            guestId: '',
            party: BookingParty.BOOKING_PARTY_GUEST,
          }),
        async () => client.cancelBooking({ id }),
      ]) {
        const error = await grpcError(call());
        expect(error.code).toBe(status.UNAUTHENTICATED);
        expect(error.details?.errorInfo?.reason).toBe('PRINCIPAL_MISSING');
      }
    });

    it('shows a booking to its guest, its host and admins; others get NOT_FOUND', async () => {
      const { booking } = await book(10, 13);
      const id = booking?.id as string;
      for (const metadata of [
        asGuest,
        await service.as(HOST_ID),
        await service.as(STRANGER_ID, { roles: ['admin'] }),
      ]) {
        await expect(client.getBooking({ id }, metadata)).resolves.toMatchObject({
          booking: { id },
        });
      }
      for (const call of [
        async () => client.getBooking({ id }, await service.as(STRANGER_ID)),
        async () => client.cancelBooking({ id }, await service.as(STRANGER_ID)),
      ]) {
        const error = await grpcError(call());
        expect(error.code).toBe(status.NOT_FOUND);
        expect(error.details?.errorInfo?.reason).toBe('BOOKING_NOT_FOUND');
      }
    });

    it('lets the host cancel, and exactly one of a guest and a host racing to cancel wins', async () => {
      const { booking } = await book(10, 13);
      const id = booking?.id as string;
      const results = await Promise.allSettled([
        client.cancelBooking({ id }, asGuest),
        client.cancelBooking({ id }, await service.as(HOST_ID)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(loser?.reason).toMatchObject({ code: status.FAILED_PRECONDITION });
    });

    it("lists only the caller's bookings, as guest or as host", async () => {
      await book(10, 11);
      await book(11, 12);
      const host = await service.as(HOST_ID);
      const stranger = await service.as(STRANGER_ID);
      expect((await list(BookingParty.BOOKING_PARTY_UNSPECIFIED, asGuest)).bookings).toHaveLength(
        2,
      );
      expect((await list(BookingParty.BOOKING_PARTY_HOST, host)).bookings).toHaveLength(2);
      expect((await list(BookingParty.BOOKING_PARTY_GUEST, host)).bookings).toHaveLength(0);
      expect((await list(BookingParty.BOOKING_PARTY_HOST, stranger)).bookings).toHaveLength(0);
      expect((await list(BookingParty.BOOKING_PARTY_GUEST, stranger)).bookings).toHaveLength(0);
      const noHouse = await list(BookingParty.BOOKING_PARTY_GUEST, asGuest, {
        houseId: '01900000-0000-7000-8000-0000000000ff',
      });
      expect(noHouse.bookings).toHaveLength(0);
    });

    it('lists every booking for admins only', async () => {
      await book(10, 11);
      const denied = await grpcError(
        list(BookingParty.BOOKING_PARTY_ANY, await service.as(STRANGER_ID)),
      );
      expect(denied.code).toBe(status.PERMISSION_DENIED);
      expect(denied.details?.errorInfo?.reason).toBe('ADMIN_ROLE_REQUIRED');
      const admin = await service.as(STRANGER_ID, { roles: ['admin'] });
      expect((await list(BookingParty.BOOKING_PARTY_ANY, admin)).bookings).toHaveLength(1);
    });

    it('binds page tokens to the caller and the party', async () => {
      await book(10, 11);
      await book(11, 12);
      const first = await client.listBookings(
        // oxlint-disable-next-line typescript/no-deprecated -- the generated type requires it until reserved
        { pageSize: 1, pageToken: '', guestId: '', party: BookingParty.BOOKING_PARTY_GUEST },
        asGuest,
      );
      expect(first.nextPageToken).not.toBe('');
      for (const [party, metadata] of [
        [BookingParty.BOOKING_PARTY_HOST, asGuest],
        [BookingParty.BOOKING_PARTY_GUEST, await service.as(HOST_ID)],
      ] as const) {
        const error = await grpcError(list(party, metadata, { pageToken: first.nextPageToken }));
        expect(error.code).toBe(status.INVALID_ARGUMENT);
      }
    });
  });
});
