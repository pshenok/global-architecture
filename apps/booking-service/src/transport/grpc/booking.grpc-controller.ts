import {
  type BookingServiceController,
  BookingServiceControllerMethods,
  type CancelBookingRequest,
  type CancelBookingResponse,
  type CreateBookingRequest,
  type CreateBookingResponse,
  type GetBookingRequest,
  type GetBookingResponse,
  type ListBookingsRequest,
  type ListBookingsResponse,
} from '@ga/contracts/ga/booking/v1/booking';
import { decodePageToken, encodePageToken, filterFingerprint, resolvePageSize } from '@ga/kernel';
import { Access, parseRequest } from '@ga/service-kit';
import { Controller } from '@nestjs/common';
import { BookingService } from '../../application/booking.service.ts';
import { toBookingMessage } from './booking.mapper.ts';
import {
  CancelBookingRequestSchema,
  CreateBookingRequestSchema,
  GetBookingRequestSchema,
  ListBookingsRequestSchema,
} from './booking.requests.ts';

/** gRPC adapter of the booking service. */
@Controller()
@BookingServiceControllerMethods()
export class BookingGrpcController implements BookingServiceController {
  constructor(private readonly bookings: BookingService) {}

  @Access.public('transitional: ADR-0004 rollout')
  async createBooking(request: CreateBookingRequest): Promise<CreateBookingResponse> {
    const input = parseRequest(CreateBookingRequestSchema, request);
    return { booking: toBookingMessage(await this.bookings.create(input)) };
  }

  @Access.public('transitional: ADR-0004 rollout')
  async getBooking(request: GetBookingRequest): Promise<GetBookingResponse> {
    const { id } = parseRequest(GetBookingRequestSchema, request);
    return { booking: toBookingMessage(await this.bookings.get(id)) };
  }

  @Access.public('transitional: ADR-0004 rollout')
  async listBookings(request: ListBookingsRequest): Promise<ListBookingsResponse> {
    const { pageSize, pageToken, guestId, houseId } = parseRequest(
      ListBookingsRequestSchema,
      request,
    );
    const filter = { guestId, houseId };
    const fingerprint = filterFingerprint(filter);
    const page = await this.bookings.list(filter, {
      limit: resolvePageSize(pageSize),
      after: decodePageToken(pageToken, fingerprint),
    });
    return {
      bookings: page.items.map(toBookingMessage),
      nextPageToken: page.nextAfter ? encodePageToken(page.nextAfter, fingerprint) : '',
    };
  }

  @Access.public('transitional: ADR-0004 rollout')
  async cancelBooking(request: CancelBookingRequest): Promise<CancelBookingResponse> {
    const { id } = parseRequest(CancelBookingRequestSchema, request);
    return { booking: toBookingMessage(await this.bookings.cancel(id)) };
  }
}
