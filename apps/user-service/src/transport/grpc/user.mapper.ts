import type { User as UserMessage } from '@ga/contracts/ga/user/v1/user';
import type { User } from '../../domain/user.ts';

/** Domain -> wire. */
export function toUserMessage(user: User): UserMessage {
  return {
    id: user.id,
    email: user.email ?? '',
    fullName: user.fullName,
    createTime: user.createdAt,
    updateTime: user.updatedAt,
    roles: [...user.roles],
  };
}
