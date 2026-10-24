import { databaseConfigSchema, grpcServiceConfigSchema } from '@ga/service-kit';
import { z } from 'zod';
import { DEFAULT_MAX_ATTEMPTS } from './domain/retry.ts';

/** Environment of the event bus, validated at boot (also in .env.example). */
export const ConfigSchema = grpcServiceConfigSchema.extend(databaseConfigSchema.shape).extend({
  /** How long a pulled delivery is the consumer's before it is leased again. */
  EVENT_BUS_LEASE_S: z.coerce.number().int().min(5).max(3_600).default(30),
  /** Leases a delivery gets before it becomes a dead letter. */
  EVENT_BUS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(DEFAULT_MAX_ATTEMPTS),
  /**
   * Days a fully delivered event is kept for `pnpm events:replay`. At most 21: consumers
   * remember processed event ids for 30 days (the kit's EventConsumer), which must exceed
   * retention plus the ~14 minute retry window, or a replay runs handlers twice.
   */
  EVENT_BUS_RETENTION_DAYS: z.coerce.number().int().min(1).max(21).default(7),
});

export type Config = z.output<typeof ConfigSchema>;
