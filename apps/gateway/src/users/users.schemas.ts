import type { User } from '@ga/contracts/ga/user/v1/user';
import { z } from 'zod';
import { iso, pageOf } from '../http/schemas.ts';

/** Registration: the identity and the email come from the bearer token, never from the body. */
export const RegisterUserBody = z
  .object({
    fullName: z.string().trim().min(1).max(200),
  })
  .meta({ id: 'RegisterUserBody' });

export const UpdateUserBody = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
  })
  .meta({ id: 'UpdateUserBody' });

/** `me` (the signed-in user) or a user id. */
export const UserIdParam = z.union([z.literal('me'), z.uuid()], {
  message: 'must be "me" or a UUID',
});

export const UserView = z
  .object({
    id: z.uuid(),
    email: z.email().nullable().describe('Null when the identity provider shared no email.'),
    fullName: z.string(),
    roles: z.array(z.string()).describe('Platform roles, e.g. "admin".'),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'User' });

export const UserPage = pageOf(UserView, 'UserPage');

export function toUserView(user: User | null | undefined): z.output<typeof UserView> {
  if (!user) throw new Error('user-service returned no user');
  return {
    id: user.id,
    email: user.email === '' ? null : user.email,
    fullName: user.fullName,
    roles: [...user.roles],
    createdAt: iso(user.createTime),
    updatedAt: iso(user.updateTime),
  };
}
