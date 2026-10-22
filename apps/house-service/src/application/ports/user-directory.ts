/**
 * What the house service needs to know about users. A port, so the use cases
 * do not depend on the user-service transport (and tests use a fake).
 */
export abstract class UserDirectory {
  /** Throws DependencyUnavailableError when the user service cannot be reached. */
  abstract exists(userId: string): Promise<boolean>;
}
