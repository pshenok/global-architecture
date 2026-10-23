import type { UserActor } from '@ga/kernel';

/**
 * What the house service needs to know about users. A port, so the use cases
 * do not depend on the user-service transport (and tests use a fake).
 */
export abstract class UserDirectory {
  /**
   * Whether the acting user still exists (it may have been deleted since its token was
   * issued). user-service answers as that user, so this cannot ask about anyone else.
   * Throws DependencyUnavailableError when user-service cannot be reached.
   */
  abstract stillExists(actor: UserActor): Promise<boolean>;
}
