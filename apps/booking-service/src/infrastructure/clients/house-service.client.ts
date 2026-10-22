import { GrpcClientsModule } from '@ga/service-kit';

/** DI token of the typed house-service client (HouseServiceClient). */
export const HOUSE_SERVICE = Symbol('HOUSE_SERVICE');

/** Outbound dependency on house-service: deadline 2 s, retries on UNAVAILABLE, request id propagated. */
export const HouseServiceClientModule = GrpcClientsModule.register([
  {
    token: HOUSE_SERVICE,
    service: 'ga.house.v1.HouseService',
    protoFiles: ['ga/house/v1/house.proto'],
    url: (config) => String(config.HOUSE_SERVICE_URL),
    timeoutMs: 2_000,
  },
]);
