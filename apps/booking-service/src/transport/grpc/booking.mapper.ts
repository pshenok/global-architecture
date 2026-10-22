import { type Booking as BookingMessage, BookingStatus } from '@ga/contracts/ga/booking/v1/booking';
import type { Booking, BookingStatus as DomainStatus } from '../../domain/booking.ts';

const STATUS: Readonly<Record<DomainStatus, BookingStatus>> = {
  CONFIRMED: BookingStatus.BOOKING_STATUS_CONFIRMED,
  CANCELLED: BookingStatus.BOOKING_STATUS_CANCELLED,
};

/** Domain -> wire. */
export function toBookingMessage(booking: Booking): BookingMessage {
  const state = booking.toState();
  return {
    id: state.id,
    houseId: state.houseId,
    guestId: state.guestId,
    checkIn: state.checkIn,
    checkOut: state.checkOut,
    guests: state.guests,
    totalPrice: { ...state.totalPrice },
    status: STATUS[state.status],
    createTime: state.createdAt,
    updateTime: state.updatedAt,
    cancelTime: state.cancelledAt,
  };
}
