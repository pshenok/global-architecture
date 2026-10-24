import type { UserDeletedEvent } from '@ga/contracts/ga/user/v1/user_events';
import { defineEvent, Outbox } from '@ga/service-kit';
import { Injectable } from '@nestjs/common';
import { UserEvents } from '../../application/ports/user-events.ts';

export const USER_DELETED = defineEvent<UserDeletedEvent>('ga.user.v1.UserDeletedEvent', {
  producer: 'user-service',
});

/** UserEvents through the transactional outbox: published once the change commits. */
@Injectable()
export class OutboxUserEvents extends UserEvents {
  constructor(private readonly outbox: Outbox) {
    super();
  }

  deleted(userId: string): Promise<void> {
    return this.outbox.add(USER_DELETED, userId, { userId });
  }
}
