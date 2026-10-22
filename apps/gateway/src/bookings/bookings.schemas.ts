import { type Booking, BookingStatus } from '@ga/contracts/ga/booking/v1/booking';
import { z } from 'zod';
import { iso, MoneyView, pageOf } from '../http/schemas.ts';

const calendarDate = z.iso.date().describe('Calendar date YYYY-MM-DD');

export const CreateBookingBody = z
  .object({
    houseId: z.uuid(),
    guestId: z.uuid(),
    checkIn: calendarDate.describe('First night, inclusive'),
    checkOut: calendarDate.describe('Departure day, exclusive'),
    guests: z.number().int().min(1).max(50),
  })
  .meta({ id: 'CreateBookingBody' });

export const BookingQuery = z.object({
  guestId: z.uuid().optional(),
  houseId: z.uuid().optional(),
});

export const BookingView = z
  .object({
    id: z.uuid(),
    houseId: z.uuid(),
    guestId: z.uuid(),
    checkIn: z.iso.date(),
    checkOut: z.iso.date(),
    guests: z.number().int(),
    totalPrice: MoneyView,
    status: z.enum(['CONFIRMED', 'CANCELLED']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    cancelledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Booking' });

export const BookingPage = pageOf(BookingView, 'BookingPage');

const STATUS: Partial<Record<BookingStatus, 'CONFIRMED' | 'CANCELLED'>> = {
  [BookingStatus.BOOKING_STATUS_CONFIRMED]: 'CONFIRMED',
  [BookingStatus.BOOKING_STATUS_CANCELLED]: 'CANCELLED',
};

export function toBookingView(booking: Booking | null | undefined): z.output<typeof BookingView> {
  const status = booking ? STATUS[booking.status] : undefined;
  if (!booking?.totalPrice || !status)
    throw new Error('booking-service returned an incomplete booking');
  return {
    id: booking.id,
    houseId: booking.houseId,
    guestId: booking.guestId,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guests: booking.guests,
    totalPrice: { ...booking.totalPrice },
    status,
    createdAt: iso(booking.createTime),
    updatedAt: iso(booking.updateTime),
    cancelledAt: booking.cancelTime ? booking.cancelTime.toISOString() : null,
  };
}
