import { defineService } from '@ga/service-kit';

/** Identity of this service: shared by AppModule (health, logs) and main.ts (gRPC server). */
export const SERVICE = defineService({
  name: 'event-bus-service',
  protoFiles: ['ga/event_bus/v1/event_bus.proto'],
  packages: ['ga.event_bus.v1'],
  services: ['ga.event_bus.v1.EventBusService'],
});
