import { ConflictError, NotFoundError, PreconditionFailedError, ValidationError } from '@ga/kernel';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  day,
  FakeHouseCatalog,
  FakeUserDirectory,
  FixedClock,
  GUEST_ID,
  HOUSE_ID,
  InMemoryBookingRepository,
  PassThroughUnitOfWork,
  SequentialIds,
} from '../../test/fakes.ts';
import { BookingService } from './booking.service.ts';

describe('BookingService', () => {
  const clock = new FixedClock();
  const stay = (from: number, to: number) => ({
    houseId: HOUSE_ID,
    guestId: GUEST_ID,
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

  it('books free dates and allows back-to-back stays', async () => {
    await service.create(stay(10, 13));
    await expect(service.create(stay(13, 15))).resolves.toBeDefined();
  });

  it('rejects overlapping dates', async () => {
    await service.create(stay(10, 13));
    await expect(service.create(stay(12, 14))).rejects.toBeInstanceOf(ConflictError);
  });

  it('frees the dates on cancel', async () => {
    const booking = await service.create(stay(10, 13));
    await service.cancel(booking.id);
    await expect(service.create(stay(10, 13))).resolves.toBeDefined();
  });

  it('rejects an unknown guest or house as a failed precondition', async () => {
    users.known.clear();
    await expect(service.create(stay(10, 11))).rejects.toBeInstanceOf(PreconditionFailedError);
    users.known.add(GUEST_ID);
    houses.houses.clear();
    await expect(service.create(stay(10, 11))).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('validates the stay before calling other services', async () => {
    users.known.clear();
    await expect(service.create(stay(-1, 2))).rejects.toBeInstanceOf(ValidationError);
  });

  it('reports NOT_FOUND when cancelling an unknown booking', async () => {
    await expect(service.cancel('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
