/**
 * Client definitions kept apart from the register call, for the probes in clients.ts. A
 * target outside a register call is no edge, so no line here is marked.
 */
import type { GrpcClientDefinition } from '@ga/service-kit';

export const BOOKING_DEFINITION: GrpcClientDefinition = {
  token: Symbol('BOOKING_SERVICE'),
  service: 'ga.booking.v1.BookingService',
  target: 'booking-service',
  protoFiles: ['ga/booking/v1/booking.proto'],
  url: () => 'localhost:50053',
};

export const DEFINITIONS: readonly GrpcClientDefinition[] = [BOOKING_DEFINITION];
