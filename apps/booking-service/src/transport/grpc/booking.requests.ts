import { z } from 'zod';

/** Validation of inbound gRPC requests (shape and format). */
const id = z.uuid({ message: 'must be a UUID' });
const calendarDate = z.iso.date({ message: 'must be a calendar date (YYYY-MM-DD)' });

export const CreateBookingRequestSchema = z.object({
  houseId: id,
  guestId: id,
  checkIn: calendarDate,
  checkOut: calendarDate,
  guests: z.number().int().min(1).max(50),
});

export const GetBookingRequestSchema = z.object({ id });

export const ListBookingsRequestSchema = z.object({
  pageSize: z.number().int().min(0),
  pageToken: z.string().max(512),
  guestId: id.optional(),
  houseId: id.optional(),
});

export const CancelBookingRequestSchema = z.object({ id });
