import { ConflictError, NotFoundError } from '@ga/kernel';

export const userNotFound = (id: string) =>
  new NotFoundError('USER_NOT_FOUND', `user ${id} not found`, { userId: id });

export const userEmailTaken = (email: string) =>
  new ConflictError('USER_EMAIL_TAKEN', `email ${email} is already registered`, { email });
