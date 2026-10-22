import { defineService } from '@ga/service-kit';

/** Identity of this service: shared by AppModule (health, logs) and main.ts (gRPC server). */
export const SERVICE = defineService({
  name: 'house-service',
  protoFiles: ['ga/house/v1/house.proto'],
  packages: ['ga.house.v1'],
  services: ['ga.house.v1.HouseService'],
});
