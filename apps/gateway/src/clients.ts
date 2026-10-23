import { GrpcClientsModule } from '@ga/service-kit';

/** DI tokens of the typed gRPC clients. */
export const USER_SERVICE = Symbol('USER_SERVICE');
export const HOUSE_SERVICE = Symbol('HOUSE_SERVICE');
export const BOOKING_SERVICE = Symbol('BOOKING_SERVICE');

/** Downstream services. Every call: 5 s deadline, x-request-id propagated, retry on UNAVAILABLE. */
export const DownstreamClientsModule = GrpcClientsModule.register([
  {
    token: USER_SERVICE,
    service: 'ga.user.v1.UserService',
    target: 'user-service',
    protoFiles: ['ga/user/v1/user.proto'],
    url: (config) => String(config.USER_SERVICE_URL),
    timeoutMs: 5_000,
  },
  {
    token: HOUSE_SERVICE,
    service: 'ga.house.v1.HouseService',
    target: 'house-service',
    protoFiles: ['ga/house/v1/house.proto'],
    url: (config) => String(config.HOUSE_SERVICE_URL),
    timeoutMs: 5_000,
  },
  {
    token: BOOKING_SERVICE,
    service: 'ga.booking.v1.BookingService',
    target: 'booking-service',
    protoFiles: ['ga/booking/v1/booking.proto'],
    url: (config) => String(config.BOOKING_SERVICE_URL),
    timeoutMs: 5_000,
  },
]);
