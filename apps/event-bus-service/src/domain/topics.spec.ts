import { describe, expect, it } from 'vitest';
import { retryDelayMs } from './retry.ts';
import { EVENT_TYPE_PATTERN, notSubscribed, subscriptions, TOPICS, topicOf } from './topics.ts';

const WORKLOAD = /^[a-z][a-z0-9-]*-service$/;

describe('the event catalog', () => {
  it('names every type ga.<domain>.v<N>.<Name>Event and only workloads as parties', () => {
    for (const [type, topic] of Object.entries(TOPICS)) {
      expect(type).toMatch(EVENT_TYPE_PATTERN);
      expect(topic.producer).toMatch(WORKLOAD);
      for (const subscriber of topic.subscribers) expect(subscriber).toMatch(WORKLOAD);
      expect(topic.subscribers).not.toContain(topic.producer);
      expect(Object.isFrozen(topic.subscribers)).toBe(true);
    }
    expect(Object.isFrozen(TOPICS)).toBe(true);
  });

  it('answers who receives what', () => {
    expect(topicOf('ga.user.v1.UserDeletedEvent')?.producer).toBe('user-service');
    expect(topicOf('constructor')).toBeUndefined();
    expect(
      notSubscribed('house-service', [
        'ga.user.v1.UserDeletedEvent',
        'ga.house.v1.HouseDeletedEvent',
      ]),
    ).toEqual(['ga.house.v1.HouseDeletedEvent']);
    expect(subscriptions()).toEqual(
      expect.arrayContaining([
        {
          subscriber: 'booking-service',
          types: ['ga.house.v1.HouseDeletedEvent', 'ga.user.v1.UserDeletedEvent'],
        },
        { subscriber: 'house-service', types: ['ga.user.v1.UserDeletedEvent'] },
      ]),
    );
  });
});

describe('retryDelayMs', () => {
  it('doubles from 1 s and stops at 5 minutes', () => {
    expect([1, 2, 3, 9, 10, 30].map(retryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 256_000, 300_000, 300_000,
    ]);
  });
});
