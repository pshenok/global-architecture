import { type Page, type PageRequest, toPage } from '@ga/kernel';
import { DbContext, translateDbError } from '@ga/service-kit';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { datesUnavailable } from '../../domain/booking.errors.ts';
import { type BookingFilter, BookingRepository } from '../../domain/booking.repository.ts';
import { Booking } from '../../domain/booking.ts';
import { type BookingRow, bookings, NO_OVERLAP_CONSTRAINT } from './schema.ts';

const toDomain = (row: BookingRow): Booking =>
  Booking.restore({
    id: row.id,
    houseId: row.houseId,
    guestId: row.guestId,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    guests: row.guests,
    totalPrice: { currencyCode: row.currencyCode, amountMinor: row.totalPriceMinor },
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cancelledAt: row.cancelledAt,
  });

const toRow = (booking: Booking): BookingRow => {
  const { totalPrice, ...state } = booking.toState();
  return {
    ...state,
    totalPriceMinor: totalPrice.amountMinor,
    currencyCode: totalPrice.currencyCode,
  };
};

/** Drizzle adapter of the BookingRepository port. */
@Injectable()
export class DrizzleBookingRepository extends BookingRepository {
  constructor(private readonly db: DbContext) {
    super();
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<Booking | null> {
    const query = this.db.tx.select().from(bookings).where(eq(bookings.id, id));
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async list(filter: BookingFilter, { limit, after }: PageRequest): Promise<Page<Booking>> {
    const rows = await this.db.tx
      .select()
      .from(bookings)
      .where(
        and(
          after ? lt(bookings.id, after) : undefined,
          filter.guestId ? eq(bookings.guestId, filter.guestId) : undefined,
          filter.houseId ? eq(bookings.houseId, filter.houseId) : undefined,
        ),
      )
      .orderBy(desc(bookings.id))
      .limit(limit + 1);
    return toPage(rows.map(toDomain), limit);
  }

  async insert(booking: Booking): Promise<void> {
    const row = toRow(booking);
    try {
      await this.db.tx.insert(bookings).values(row);
    } catch (error) {
      throw translateDbError(error, {
        [NO_OVERLAP_CONSTRAINT]: () => datesUnavailable(row.houseId),
      });
    }
  }

  async update(booking: Booking): Promise<void> {
    const { id, ...row } = toRow(booking);
    await this.db.tx.update(bookings).set(row).where(eq(bookings.id, id));
  }
}
