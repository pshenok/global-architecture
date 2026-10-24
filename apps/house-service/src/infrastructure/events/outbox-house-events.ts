import type { HouseDeletedEvent } from '@ga/contracts/ga/house/v1/house_events';
import { defineEvent, Outbox } from '@ga/service-kit';
import { Injectable } from '@nestjs/common';
import { HouseEvents } from '../../application/ports/house-events.ts';
import type { House } from '../../domain/house.ts';

export const HOUSE_DELETED = defineEvent<HouseDeletedEvent>('ga.house.v1.HouseDeletedEvent', {
  producer: 'house-service',
});

/** HouseEvents through the transactional outbox: published once the change commits. */
@Injectable()
export class OutboxHouseEvents extends HouseEvents {
  constructor(private readonly outbox: Outbox) {
    super();
  }

  deleted(house: House): Promise<void> {
    return this.outbox.add(HOUSE_DELETED, house.id, { houseId: house.id, ownerId: house.ownerId });
  }
}
