import type { User } from '@ga/contracts/ga/user/v1/user';
import { z } from 'zod';
import { iso, pageOf } from '../http/schemas.ts';

export const CreateUserBody = z
  .object({
    email: z.email().max(254),
    fullName: z.string().trim().min(1).max(200),
  })
  .meta({ id: 'CreateUserBody' });

export const UpdateUserBody = z
  .object({
    email: z.email().max(254).optional(),
    fullName: z.string().trim().min(1).max(200).optional(),
  })
  .meta({ id: 'UpdateUserBody' });

export const UserView = z
  .object({
    id: z.uuid(),
    email: z.email(),
    fullName: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'User' });

export const UserPage = pageOf(UserView, 'UserPage');

export function toUserView(user: User | null | undefined): z.output<typeof UserView> {
  if (!user) throw new Error('user-service returned no user');
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    createdAt: iso(user.createTime),
    updatedAt: iso(user.updateTime),
  };
}
