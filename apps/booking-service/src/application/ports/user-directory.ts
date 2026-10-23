import type { UserActor } from '@ga/kernel';

/** What the booking service needs to know about users. */
export abstract class UserDirectory {
  /**
   * Whether the acting user still exists (it may have been deleted since its token was
   * issued). user-service answers as that user, so this cannot ask about anyone else.
   * Throws DependencyUnavailableError when user-service cannot be reached.
   */
  abstract stillExists(actor: UserActor): Promise<boolean>;
}
