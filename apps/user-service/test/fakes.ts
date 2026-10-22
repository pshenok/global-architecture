import { Clock, IdGenerator, type Page, type PageRequest, toPage, UnitOfWork } from '@ga/kernel';
import { userEmailTaken } from '../src/domain/user.errors.ts';
import { UserRepository } from '../src/domain/user.repository.ts';
import { User } from '../src/domain/user.ts';

/**
 * "YYYY-MM-DD" n days after `from` (UTC). In use-case tests pass `clock.now()` as `from`,
 * so dates stay consistent with the FixedClock instead of the real date.
 */
export function day(n: number, from: Date = new Date()): string {
  const base = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
}

/** Deterministic, sortable UUIDv7-shaped ids: ...-000000000001, ...-000000000002, ... */
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

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Runs the work without a transaction (in-memory fakes have nothing to roll back). */
export class PassThroughUnitOfWork extends UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}

/** In-memory adapter with the same contract as the Drizzle one (unique email, newest first). */
export class InMemoryUserRepository extends UserRepository {
  readonly rows = new Map<string, ReturnType<User['toState']>>();

  async findById(id: string): Promise<User | null> {
    const state = this.rows.get(id);
    return state ? User.restore(state) : null;
  }

  async list({ limit, after }: PageRequest): Promise<Page<User>> {
    const sorted = [...this.rows.values()]
      .filter((state) => after === null || state.id < after)
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit + 1)
      .map((state) => User.restore(state));
    return toPage(sorted, limit);
  }

  async insert(user: User): Promise<void> {
    this.assertEmailFree(user);
    this.rows.set(user.id, user.toState());
  }

  async update(user: User): Promise<void> {
    this.assertEmailFree(user);
    this.rows.set(user.id, user.toState());
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  private assertEmailFree(user: User): void {
    for (const state of this.rows.values()) {
      if (state.email === user.email && state.id !== user.id) throw userEmailTaken(user.email);
    }
  }
}
