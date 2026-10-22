import { GrpcClientsModule } from '@ga/service-kit';

/** DI token of the typed user-service client (UserServiceClient). */
export const USER_SERVICE = Symbol('USER_SERVICE');

/** Outbound dependency on user-service: deadline 2 s, retries on UNAVAILABLE, request id propagated. */
export const UserServiceClientModule = GrpcClientsModule.register([
  {
    token: USER_SERVICE,
    service: 'ga.user.v1.UserService',
    protoFiles: ['ga/user/v1/user.proto'],
    url: (config) => String(config.USER_SERVICE_URL),
    timeoutMs: 2_000,
  },
]);
