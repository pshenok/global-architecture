import {
  databaseConfigSchema,
  eventsConfigSchema,
  grpcServiceConfigSchema,
  grpcTarget,
} from '@ga/service-kit';
import type { z } from 'zod';

/** Environment of the house service, validated at boot. */
export const ConfigSchema = grpcServiceConfigSchema.extend({
  ...databaseConfigSchema.shape,
  ...eventsConfigSchema.shape,
  /** user-service address, e.g. localhost:50051 */
  USER_SERVICE_URL: grpcTarget(),
});

export type Config = z.output<typeof ConfigSchema>;
