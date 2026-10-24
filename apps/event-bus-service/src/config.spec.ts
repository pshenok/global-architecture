import { parseConfig } from '@ga/service-kit';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './config.ts';

describe('event bus config', () => {
  const env = {
    GRPC_PORT: '50050',
    DATABASE_URL: 'postgresql://ga:ga@localhost:5432/ga_event_bus',
    WORKLOAD_KEY_FILE: '/keys/event-bus-service.jwk.json',
    WORKLOAD_KEYS_FILE: '/keys/workload-keys.json',
  };
  const retention = (days?: string) =>
    parseConfig(ConfigSchema, { ...env, EVENT_BUS_RETENTION_DAYS: days }).EVENT_BUS_RETENTION_DAYS;

  it('keeps delivered events 7 days by default', () => {
    expect(retention()).toBe(7);
  });

  it('refuses a retention longer than consumers remember processed events', () => {
    expect(retention('21')).toBe(21);
    expect(() => retention('22')).toThrow('EVENT_BUS_RETENTION_DAYS');
  });
});
