import { GrpcClientsModule } from '@ga/service-kit';

/** DI token of the typed user-service client (UserServiceClient). */
export const USER_SERVICE = Symbol('USER_SERVICE');
/** DI token of the typed house-service client (HouseServiceClient). */
export const HOUSE_SERVICE = Symbol('HOUSE_SERVICE');

/** Outbound dependencies of the booking service. */
export const DependencyClientsModule = GrpcClientsModule.register([
  {
    token: USER_SERVICE,
    service: 'ga.user.v1.UserService',
    protoFiles: ['ga/user/v1/user.proto'],
    url: (config) => String(config['USER_SERVICE_URL']),
    timeoutMs: 2_000,
  },
  {
    token: HOUSE_SERVICE,
    service: 'ga.house.v1.HouseService',
    protoFiles: ['ga/house/v1/house.proto'],
    url: (config) => String(config['HOUSE_SERVICE_URL']),
    timeoutMs: 2_000,
  },
]);
