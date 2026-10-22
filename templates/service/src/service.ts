import { defineService } from '@ga/service-kit';

/** Identity of this service: shared by AppModule (health, logs) and main.ts (gRPC server). */
export const SERVICE = defineService({
  name: 'sample-item-service',
  protoFiles: ['ga/sample_item/v1/sample_item.proto'],
  packages: ['ga.sample_item.v1'],
  services: ['ga.sample_item.v1.SampleItemService'],
});
