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
import { Access, currentUser, parseRequest } from '@ga/service-kit';
import { Controller } from '@nestjs/common';
import { BookingService } from '../../application/booking.service.ts';
import type { BookingParty } from '../../domain/booking-scope.ts';
import { toBookingMessage } from './booking.mapper.ts';
import {
  CancelBookingRequestSchema,
  CreateBookingRequestSchema,
  GetBookingRequestSchema,
  ListBookingsRequestSchema,
} from './booking.requests.ts';

const PARTY: Readonly<Record<string, BookingParty>> = {
  BOOKING_PARTY_UNSPECIFIED: 'guest',
  BOOKING_PARTY_GUEST: 'guest',
  BOOKING_PARTY_HOST: 'host',
  BOOKING_PARTY_ANY: 'any',
};

/** gRPC adapter of the booking service. */
@Controller()
@BookingServiceControllerMethods()
export class BookingGrpcController implements BookingServiceController {
  constructor(private readonly bookings: BookingService) {}

  @Access.user()
  async createBooking(request: CreateBookingRequest): Promise<CreateBookingResponse> {
    const input = parseRequest(CreateBookingRequestSchema, request);
    return { booking: toBookingMessage(await this.bookings.create(currentUser(), input)) };
  }

  @Access.user()
  async getBooking(request: GetBookingRequest): Promise<GetBookingResponse> {
    const { id } = parseRequest(GetBookingRequestSchema, request);
    return { booking: toBookingMessage(await this.bookings.get(currentUser(), id)) };
  }

  @Access.user()
  async listBookings(request: ListBookingsRequest): Promise<ListBookingsResponse> {
    const { pageSize, pageToken, houseId, party } = parseRequest(
      ListBookingsRequestSchema,
      request,
    );
    const actor = currentUser();
    const scope = PARTY[party] as BookingParty;
    // The token is bound to the scope too, so it cannot be replayed by another user or party.
    const fingerprint = filterFingerprint({ party: scope, userId: actor.userId, houseId });
    const page = await this.bookings.list(
      actor,
      scope,
      { houseId },
      { limit: resolvePageSize(pageSize), after: decodePageToken(pageToken, fingerprint) },
    );
    return {
      bookings: page.items.map(toBookingMessage),
      nextPageToken: page.nextAfter ? encodePageToken(page.nextAfter, fingerprint) : '',
    };
  }

  @Access.user()
  async cancelBooking(request: CancelBookingRequest): Promise<CancelBookingResponse> {
    const { id } = parseRequest(CancelBookingRequestSchema, request);
    return { booking: toBookingMessage(await this.bookings.cancel(currentUser(), id)) };
  }
}
