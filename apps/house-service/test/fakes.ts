import { Clock, IdGenerator, type Page, type PageRequest, toPage, UnitOfWork } from '@ga/kernel';
import { UserDirectory } from '../src/application/ports/user-directory.ts';
import { type HouseFilter, HouseRepository } from '../src/domain/house.repository.ts';
import { House, type HouseState } from '../src/domain/house.ts';

export class SequentialIds extends IdGenerator {
  private next = 0;

  newId(): string {
    this.next += 1;
    return `01900000-0000-7000-8000-${String(this.next).padStart(12, '0')}`;
  }
}

export class FixedClock extends Clock {
  constructor(public current = new Date('2026-01-01T00:00:00.000Z')) {
    super();
  }

  now(): Date {
    return this.current;
  }
}

export class PassThroughUnitOfWork extends UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}

/** UserDirectory that knows a fixed set of user ids. */
export class FakeUserDirectory extends UserDirectory {
  constructor(public readonly known = new Set<string>()) {
    super();
  }

  async exists(userId: string): Promise<boolean> {
    return this.known.has(userId);
  }
}

export class InMemoryHouseRepository extends HouseRepository {
  readonly rows = new Map<string, HouseState>();

  async findById(id: string): Promise<House | null> {
    const state = this.rows.get(id);
    return state ? House.restore(state) : null;
  }

  async list(filter: HouseFilter, { limit, after }: PageRequest): Promise<Page<House>> {
    const rows = [...this.rows.values()]
      .filter((s) => after === null || s.id < after)
      .filter((s) => !filter.ownerId || s.ownerId === filter.ownerId)
      .filter((s) => !filter.city || s.address.city.toLowerCase() === filter.city.toLowerCase())
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit + 1)
      .map((s) => House.restore(s));
    return toPage(rows, limit);
  }

  async insert(house: House): Promise<void> {
    this.rows.set(house.id, house.toState());
  }

  async update(house: House): Promise<void> {
    this.rows.set(house.id, house.toState());
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

export const OWNER_ID = '01900000-0000-7000-8000-0000000000aa';

export const houseInput = (overrides: Record<string, unknown> = {}) => ({
  ownerId: OWNER_ID,
  title: 'Sea view loft',
  description: 'Two rooms by the sea',
  address: { line1: '1 Beach St', city: 'Odesa', countryCode: 'UA' },
  nightlyPrice: { currencyCode: 'USD', amountMinor: 12_000 },
  maxGuests: 4,
  ...overrides,
});
