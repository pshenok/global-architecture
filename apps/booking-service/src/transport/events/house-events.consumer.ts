import type { HouseDeletedEvent } from '@ga/contracts/ga/house/v1/house_events';
import { currentService, defineEvent, OnEvent } from '@ga/service-kit';
import { Injectable } from '@nestjs/common';
import { BookingService } from '../../application/booking.service.ts';

const HOUSE_DELETED = defineEvent<HouseDeletedEvent>('ga.house.v1.HouseDeletedEvent', {
  producer: 'house-service',
});

/** Reactions to house-service's events: one use case per event, no business logic here. */
@Injectable()
export class HouseEventsConsumer {
  constructor(private readonly bookings: BookingService) {}

  /** Covers the host's stays too: a deleted host's houses each announce their deletion. */
  @OnEvent(HOUSE_DELETED)
  async houseDeleted(event: HouseDeletedEvent): Promise<void> {
    await this.bookings.cancelOpenStaysOfHouse(currentService(), event.houseId);
  }
}
