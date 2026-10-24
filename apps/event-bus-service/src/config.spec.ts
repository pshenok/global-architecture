import { PROCESSED_EVENTS_KEPT_DAYS, parseConfig } from '@ga/service-kit';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './config.ts';
import { MAX_RETENTION_DAYS } from './domain/retention.ts';
import { retryDelayMs } from './domain/retry.ts';

const DAY_MS = 86_400_000;

describe('event bus config', () => {
  const env = {
    GRPC_PORT: '50050',
    DATABASE_URL: 'postgresql://ga:ga@localhost:5432/ga_event_bus',
    WORKLOAD_KEY_FILE: '/keys/event-bus-service.jwk.json',
    WORKLOAD_KEYS_FILE: '/keys/workload-keys.json',
  };
  const parse = (extra: Record<string, string>) => parseConfig(ConfigSchema, { ...env, ...extra });

  it('keeps delivered events 7 days by default', () => {
    expect(parse({}).EVENT_BUS_RETENTION_DAYS).toBe(7);
  });

  it('refuses a retention longer than replay can deliver safely', () => {
    const at = (days: number) => ({ EVENT_BUS_RETENTION_DAYS: String(days) });
    expect(parse(at(MAX_RETENTION_DAYS)).EVENT_BUS_RETENTION_DAYS).toBe(MAX_RETENTION_DAYS);
    expect(() => parse(at(MAX_RETENTION_DAYS + 1))).toThrow('EVENT_BUS_RETENTION_DAYS');
  });

  it("keeps every replayable event inside the consumers' dedupe window, at the longest retries", () => {
    // The largest settings the config accepts...
    const longest = { EVENT_BUS_MAX_ATTEMPTS: '100', EVENT_BUS_LEASE_S: '3600' };
    const config = parse(longest);
    expect(() => parse({ ...longest, EVENT_BUS_MAX_ATTEMPTS: '101' })).toThrow();
    expect(() => parse({ ...longest, EVENT_BUS_LEASE_S: '3601' })).toThrow();
    // ...give the longest time a delivery can stay in flight: every lease plus every backoff.
    let inFlightMs = 0;
    for (let attempt = 1; attempt <= config.EVENT_BUS_MAX_ATTEMPTS; attempt += 1) {
      inFlightMs += config.EVENT_BUS_LEASE_S * 1_000 + retryDelayMs(attempt);
    }
    expect(MAX_RETENTION_DAYS * DAY_MS + inFlightMs).toBeLessThan(
      PROCESSED_EVENTS_KEPT_DAYS * DAY_MS,
    );
  });
});
