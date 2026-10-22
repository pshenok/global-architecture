import { databaseConfigSchema, grpcServiceConfigSchema } from '@ga/service-kit';
import type { z } from 'zod';

/**
 * Environment of this service, validated at boot. Add service-specific
 * variables here (e.g. `OTHER_SERVICE_URL: grpcTarget()`) and to .env.example.
 */
export const ConfigSchema = grpcServiceConfigSchema.extend(databaseConfigSchema.shape);

export type Config = z.output<typeof ConfigSchema>;
