import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  ValidationError,
} from '@ga/kernel';
import { adminActor, userActor } from '@ga/kernel/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  day,
  FakeHouseCatalog,
  FakeUserDirectory,
  FixedClock,
  GUEST_ID,
  HOST_ID,
  HOUSE_ID,
  InMemoryBookingRepository,
  PassThroughUnitOfWork,
  SequentialIds,
  STRANGER_ID,
} from '../../test/fakes.ts';
import { BookingService } from './booking.service.ts';

const guest = userActor(GUEST_ID);
const host = userActor(HOST_ID);
const stranger = userActor(STRANGER_ID);

describe('BookingService', () => {
  const clock = new FixedClock();
  const stay = (from: number, to: number) => ({
    houseId: HOUSE_ID,
    checkIn: day(from, clock.now()),
    checkOut: day(to, clock.now()),
    guests: 2,
  });
  let users: FakeUserDirectory;
  let houses: FakeHouseCatalog;
  let service: BookingService;

  beforeEach(() => {
    users = new FakeUserDirectory();
    houses = new FakeHouseCatalog();
    service = new BookingService(
      new InMemoryBookingRepository(),
      users,
      houses,
      new SequentialIds(),
      clock,
      new PassThroughUnitOfWork(),
    );
  });

  it('books for the acting user and snapshots the house owner as host', async () => {
    const booking = await service.create(guest, stay(10, 13));
    expect(booking.toState()).toMatchObject({ guestId: GUEST_ID, hostId: HOST_ID });
  });

  it('books free dates and allows back-to-back stays', async () => {
    await service.create(guest, stay(10, 13));
    await expect(service.create(guest, stay(13, 15))).resolves.toBeDefined();
  });

  it('rejects overlapping dates', async () => {
    await service.create(guest, stay(10, 13));
    await expect(service.create(guest, stay(12, 14))).rejects.toBeInstanceOf(ConflictError);
  });

  it('frees the dates on cancel', async () => {
    const booking = await service.create(guest, stay(10, 13));
    await service.cancel(guest, booking.id);
    await expect(service.create(guest, stay(10, 13))).resolves.toBeDefined();
  });

  it('rejects a missing guest account or house as a failed precondition', async () => {
    users.known.clear();
    await expect(service.create(guest, stay(10, 11))).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    users.known.add(GUEST_ID);
    houses.houses.clear();
    await expect(service.create(guest, stay(10, 11))).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
  });

  it('validates the stay before calling other services', async () => {
    users.known.clear();
    await expect(service.create(guest, stay(-1, 2))).rejects.toBeInstanceOf(ValidationError);
  });

  it('reports NOT_FOUND when cancelling an unknown booking', async () => {
    await expect(service.cancel(guest, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('visibility', () => {
    it('shows a booking to its guest, its host and admins, and hides it from others', async () => {
      const { id } = await service.create(guest, stay(10, 13));
      for (const actor of [guest, host, adminActor(STRANGER_ID)]) {
        await expect(service.get(actor, id)).resolves.toMatchObject({ id });
      }
      await expect(service.get(stranger, id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('lets the host cancel, but answers a stranger as if the booking did not exist', async () => {
      const { id } = await service.create(guest, stay(10, 13));
      await expect(service.cancel(stranger, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.cancel(host, id)).resolves.toMatchObject({ status: 'CANCELLED' });
    });

    it('scopes lists to the caller, and only admins list everything', async () => {
      await service.create(guest, stay(10, 11));
      await service.create(guest, stay(11, 12));
      const page = { limit: 10, after: null };
      expect((await service.list(guest, 'guest', {}, page)).items).toHaveLength(2);
      expect((await service.list(host, 'host', {}, page)).items).toHaveLength(2);
      expect((await service.list(host, 'guest', {}, page)).items).toHaveLength(0);
      expect((await service.list(stranger, 'host', {}, page)).items).toHaveLength(0);
      await expect(service.list(stranger, 'any', {}, page)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      expect((await service.list(adminActor(STRANGER_ID), 'any', {}, page)).items).toHaveLength(2);
    });
  });
});
