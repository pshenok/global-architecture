import { z } from 'zod';

/** Validation of inbound gRPC requests (shape and format). */
const id = z.uuid({ message: 'must be a UUID' });
const calendarDate = z.iso.date({ message: 'must be a calendar date (YYYY-MM-DD)' });

/** `guest_id` is deprecated and ignored: the guest is the calling user. */
export const CreateBookingRequestSchema = z.object({
  houseId: id,
  checkIn: calendarDate,
  checkOut: calendarDate,
  guests: z.number().int().min(1).max(50),
});

export const GetBookingRequestSchema = z.object({ id });

/** `guest_id` is deprecated and ignored: `party` scopes the list to the caller. */
export const ListBookingsRequestSchema = z.object({
  pageSize: z.number().int().min(0),
  pageToken: z.string().max(512),
  houseId: id.optional(),
  party: z.enum([
    'BOOKING_PARTY_UNSPECIFIED',
    'BOOKING_PARTY_GUEST',
    'BOOKING_PARTY_HOST',
    'BOOKING_PARTY_ANY',
  ]),
});

export const CancelBookingRequestSchema = z.object({ id });
