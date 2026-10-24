import { describe, expect, it } from 'vitest';
import { assertPullableTypes, MAX_PULL_TYPES } from './event-consumer.ts';

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
