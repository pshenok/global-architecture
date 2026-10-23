import type { Page, PageRequest } from '@ga/kernel';
import type { Booking } from './booking.ts';
import type { BookingScope } from './booking-scope.ts';

/** Optional narrowing within a scope. */
export interface BookingFilter {
  readonly houseId?: string | undefined;
}

/** Persistence port for Booking. */
export abstract class BookingRepository {
  /** `forUpdate` locks the row until the surrounding UnitOfWork ends. */
  abstract findById(id: string, options?: { forUpdate?: boolean }): Promise<Booking | null>;
  /** Newest first, only rows inside `scope`. */
  abstract list(
    scope: BookingScope,
    filter: BookingFilter,
    page: PageRequest,
  ): Promise<Page<Booking>>;
  /** Throws ConflictError (BOOKING_DATES_UNAVAILABLE) when the stay overlaps a confirmed booking of the house. */
  abstract insert(booking: Booking): Promise<void>;
  abstract update(booking: Booking): Promise<void>;
}
