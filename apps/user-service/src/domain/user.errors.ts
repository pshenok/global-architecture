import { ConflictError, NotFoundError } from '@ga/kernel';

export const userNotFound = (id: string) =>
  new NotFoundError('USER_NOT_FOUND', `user ${id} not found`, { userId: id });

export const userEmailTaken = (email: string | null) =>
  new ConflictError(
    'USER_EMAIL_TAKEN',
    `email ${email} is already registered`,
    email === null ? {} : { email },
  );

/** The calling identity already has a user (registration is once per identity). */
export const userAlreadyRegistered = () =>
  new ConflictError('USER_ALREADY_REGISTERED', 'this identity is already registered');

/** The calling identity has no user yet; it must register first. */
export const userNotRegistered = () =>
  new NotFoundError('USER_NOT_REGISTERED', 'this identity has no user; register first');
