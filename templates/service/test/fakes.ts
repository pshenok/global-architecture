import { Clock, IdGenerator, type Page, type PageRequest, toPage, UnitOfWork } from '@ga/kernel';
import { sampleItemNameTaken } from '../src/domain/sample-item.errors.ts';
import { SampleItemRepository } from '../src/domain/sample-item.repository.ts';
import { SampleItem } from '../src/domain/sample-item.ts';

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

/** In-memory adapter with the same contract as the Drizzle one (unique name, newest first). */
export class InMemorySampleItemRepository extends SampleItemRepository {
  readonly rows = new Map<string, ReturnType<SampleItem['toState']>>();

  async findById(id: string): Promise<SampleItem | null> {
    const state = this.rows.get(id);
    return state ? SampleItem.restore(state) : null;
  }

  async list({ limit, after }: PageRequest): Promise<Page<SampleItem>> {
    const sorted = [...this.rows.values()]
      .filter((state) => after === null || state.id < after)
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit + 1)
      .map((state) => SampleItem.restore(state));
    return toPage(sorted, limit);
  }

  async insert(sampleItem: SampleItem): Promise<void> {
    this.assertNameFree(sampleItem);
    this.rows.set(sampleItem.id, sampleItem.toState());
  }

  async update(sampleItem: SampleItem): Promise<void> {
    this.assertNameFree(sampleItem);
    this.rows.set(sampleItem.id, sampleItem.toState());
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  private assertNameFree(sampleItem: SampleItem): void {
    for (const state of this.rows.values()) {
      if (state.name === sampleItem.name && state.id !== sampleItem.id)
        throw sampleItemNameTaken(sampleItem.name);
    }
  }
}
