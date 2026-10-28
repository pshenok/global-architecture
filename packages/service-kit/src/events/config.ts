import { z } from 'zod';
import { grpcTarget } from '../config/config.ts';

/**
 * Variables of services that publish or consume events (ADR-0005). Spread
 * `...eventsConfigSchema.shape` into the service's ConfigSchema.
 *
 * Shutdown budget: EVENTS_DRAIN_MS + SHUTDOWN_DELAY_MS must stay below the time the
 * process manager waits before it kills the process (PM2 kill_timeout, Kubernetes
 * terminationGracePeriodSeconds), so an in-flight publish or delivery can finish.
 */
export const eventsConfigSchema = z.object({
  /** `host:port` of event-bus-service. */
  EVENT_BUS_SERVICE_URL: grpcTarget(),
  /** Run the outbox relay and the consumer loop. Tests turn it off and drive them by hand. */
  EVENTS_AUTOSTART: z.stringbool().default(true),
  /** Idle wait between outbox claims and between pulls. */
  EVENTS_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(500),
  /** How long shutdown waits for an in-flight publish or delivery. */
  EVENTS_DRAIN_MS: z.coerce.number().int().min(0).max(14_000).default(5_000),
});

export type EventsConfig = z.output<typeof eventsConfigSchema>;

/** The same variables as the service's parsed CONFIG holds them (kit-internal check). */
export const parsedEventsConfigSchema = z.object({
  EVENT_BUS_SERVICE_URL: z.string(),
  EVENTS_AUTOSTART: z.boolean(),
  EVENTS_POLL_MS: z.number(),
  EVENTS_DRAIN_MS: z.number(),
});
