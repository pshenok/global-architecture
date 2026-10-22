import type { Page, PageRequest } from '@ga/kernel';
import type { User } from './user.ts';

/**
 * Persistence port for User. The application layer depends on this
 * abstract class (it doubles as the Nest DI token); infrastructure implements it.
 */
export abstract class UserRepository {
  /** `forUpdate` locks the row until the surrounding UnitOfWork ends. */
  abstract findById(id: string, options?: { forUpdate?: boolean }): Promise<User | null>;
  /** Newest first. */
  abstract list(page: PageRequest): Promise<Page<User>>;
  /** Throws a ConflictError when the email is taken. */
  abstract insert(item: User): Promise<void>;
  /** Throws a ConflictError when the email is taken. */
  abstract update(item: User): Promise<void>;
  /** Returns false when nothing was deleted. */
  abstract delete(id: string): Promise<boolean>;
}
