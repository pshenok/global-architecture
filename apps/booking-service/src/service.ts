import { defineService } from '@ga/service-kit';

/** Identity of this service: shared by AppModule (health, logs) and main.ts (gRPC server). */
export const SERVICE = defineService({
  name: 'booking-service',
  protoFiles: ['ga/booking/v1/booking.proto'],
  packages: ['ga.booking.v1'],
  services: ['ga.booking.v1.BookingService'],
});
