import type { UserDeletedEvent } from '@ga/contracts/ga/user/v1/user_events';
import { currentService, defineEvent, OnEvent } from '@ga/service-kit';
import { Injectable } from '@nestjs/common';
import { HouseService } from '../../application/house.service.ts';

const USER_DELETED = defineEvent<UserDeletedEvent>('ga.user.v1.UserDeletedEvent', {
  producer: 'user-service',
});

/** Reactions to user-service's events: one use case per event, no business logic here. */
@Injectable()
export class UserEventsConsumer {
  constructor(private readonly houses: HouseService) {}

  /** The owner's account is gone: so are its houses (each announces HouseDeletedEvent). */
  @OnEvent(USER_DELETED)
  async userDeleted(event: UserDeletedEvent): Promise<void> {
    await this.houses.removeAllOf(currentService(), event.userId);
  }
}
