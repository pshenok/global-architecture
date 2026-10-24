import { databaseConfigSchema, grpcServiceConfigSchema } from '@ga/service-kit';
import { z } from 'zod';
import { MAX_RETENTION_DAYS } from './domain/retention.ts';
import { DEFAULT_MAX_ATTEMPTS } from './domain/retry.ts';

/** Environment of the event bus, validated at boot (also in .env.example). */
export const ConfigSchema = grpcServiceConfigSchema.extend(databaseConfigSchema.shape).extend({
  /** How long a pulled delivery is the consumer's before it is leased again. */
  EVENT_BUS_LEASE_S: z.coerce.number().int().min(5).max(3_600).default(30),
  /** Leases a delivery gets before it becomes a dead letter. */
  EVENT_BUS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(DEFAULT_MAX_ATTEMPTS),
  /**
   * Days a fully delivered event is kept for `pnpm events:replay`. At most
   * MAX_RETENTION_DAYS (21): consumers forget processed event ids after 30 days.
   */
  EVENT_BUS_RETENTION_DAYS: z.coerce.number().int().min(1).max(MAX_RETENTION_DAYS).default(7),
});

export type Config = z.output<typeof ConfigSchema>;
