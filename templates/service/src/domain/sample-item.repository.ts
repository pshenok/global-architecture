import type { Page, PageRequest } from '@ga/kernel';
import type { SampleItem } from './sample-item.ts';

/**
 * Persistence port for SampleItem. The application layer depends on this
 * abstract class (it doubles as the Nest DI token); infrastructure implements it.
 */
export abstract class SampleItemRepository {
  /** `forUpdate` locks the row until the surrounding UnitOfWork ends. */
  abstract findById(id: string, options?: { forUpdate?: boolean }): Promise<SampleItem | null>;
  /** Newest first. */
  abstract list(page: PageRequest): Promise<Page<SampleItem>>;
  /** Throws a ConflictError when the name is taken. */
  abstract insert(item: SampleItem): Promise<void>;
  /** Throws a ConflictError when the name is taken. */
  abstract update(item: SampleItem): Promise<void>;
  /** Returns false when nothing was deleted. */
  abstract delete(id: string): Promise<boolean>;
}
