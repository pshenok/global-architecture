import type { DiscoveryService } from '@nestjs/core';
import { MetadataScanner } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { assertPullableTypes, EventConsumer, MAX_PULL_TYPES } from './event-consumer.ts';
import { OnEvent } from './on-event.ts';

describe('assertPullableTypes', () => {
  const types = (count: number) =>
    Array.from({ length: count }, (_, i) => `ga.test.v1.Thing${i}HappenedEvent`);

  it('accepts as many types as one Pull asks for (PullRequest: 1..50)', () => {
    expect(MAX_PULL_TYPES).toBe(50);
    expect(() => assertPullableTypes(types(50))).not.toThrow();
  });

  it('fails boot on more, before the bus refuses every pull', () => {
    expect(() => assertPullableTypes(types(51))).toThrow(
      '51 @OnEvent types, but one Pull asks for at most 50',
    );
  });
});

describe('EventConsumer at boot', () => {
  it('refuses a service with more event types than one Pull asks for', () => {
    class ManyHandlers {}
    for (let i = 0; i <= MAX_PULL_TYPES; i += 1) {
      const handler = async (_payload: object) => {};
      Object.defineProperty(ManyHandlers.prototype, `on${i}`, {
        value: handler,
        writable: true,
        configurable: true,
      });
      OnEvent({
        type: `ga.test.v1.Thing${i}HappenedEvent`,
        producer: 'test-service',
        protoFile: 'ga/test/v1/test_events.proto',
      })(ManyHandlers.prototype, `on${i}`, { value: handler });
    }
    const discovery = {
      getProviders: () => [{ instance: new ManyHandlers(), isDependencyTreeStatic: () => true }],
    } as unknown as DiscoveryService;
    const unused = {} as never;
    const consumer = new EventConsumer(
      discovery,
      new MetadataScanner(),
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
    );
    expect(() => consumer.onModuleInit()).toThrow(
      `${MAX_PULL_TYPES + 1} @OnEvent types, but one Pull asks for at most ${MAX_PULL_TYPES}`,
    );
  });
});
