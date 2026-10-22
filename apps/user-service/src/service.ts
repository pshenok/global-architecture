import { defineService } from '@ga/service-kit';

/** Identity of this service: shared by AppModule (health, logs) and main.ts (gRPC server). */
export const SERVICE = defineService({
  name: 'user-service',
  protoFiles: ['ga/user/v1/user.proto'],
  packages: ['ga.user.v1'],
  services: ['ga.user.v1.UserService'],
});
