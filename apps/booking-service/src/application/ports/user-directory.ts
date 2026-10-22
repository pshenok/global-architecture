/** What the booking service needs to know about users. */
export abstract class UserDirectory {
  /** Throws DependencyUnavailableError when user-service cannot be reached. */
  abstract exists(userId: string): Promise<boolean>;
}
