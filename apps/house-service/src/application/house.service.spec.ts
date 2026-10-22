import { NotFoundError, PreconditionFailedError } from '@ga/kernel';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeUserDirectory,
  FixedClock,
  houseInput,
  InMemoryHouseRepository,
  OWNER_ID,
  PassThroughUnitOfWork,
  SequentialIds,
} from '../../test/fakes.ts';
import { HouseService } from './house.service.ts';

describe('HouseService', () => {
  let users: FakeUserDirectory;
  let service: HouseService;

  beforeEach(() => {
    users = new FakeUserDirectory(new Set([OWNER_ID]));
    service = new HouseService(
      new InMemoryHouseRepository(),
      users,
      new SequentialIds(),
      new FixedClock(),
      new PassThroughUnitOfWork(),
    );
  });

  it('lists a house for an existing owner', async () => {
    const house = await service.create(houseInput());
    await expect(service.get(house.id)).resolves.toMatchObject({ ownerId: OWNER_ID });
  });

  it('refuses an owner that user-service does not know', async () => {
    users.known.clear();
    await expect(service.create(houseInput())).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('filters by owner and case-insensitive city', async () => {
    const other = '01900000-0000-7000-8000-0000000000bb';
    users.known.add(other);
    await service.create(houseInput());
    await service.create(
      houseInput({ address: { line1: '2 Main', city: 'Kyiv', countryCode: 'UA' } }),
    );
    await service.create(houseInput({ ownerId: other }));
    const inKyiv = await service.list({ city: 'KYIV' }, { limit: 10, after: null });
    expect(inKyiv.items).toHaveLength(1);
    const ofOther = await service.list({ ownerId: other }, { limit: 10, after: null });
    expect(ofOther.items.map((h) => h.ownerId)).toEqual([other]);
  });

  it('reports NOT_FOUND for unknown ids', async () => {
    await expect(service.update('missing', { maxGuests: 2 })).rejects.toBeInstanceOf(NotFoundError);
  });
});
