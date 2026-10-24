import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BusEvent, EventBroker } from '../src/application/ports/event-broker.ts';

/** What the contract needs from a backend under test. */
export interface BrokerHarness {
  readonly broker: EventBroker;
  /** EVENT_BUS_MAX_ATTEMPTS the broker runs with; at least 3. */
  readonly maxAttempts: number;
  /** Ends every current lease and backoff now, as if their time had passed. */
  elapse(): Promise<void>;
  /** Empties the store between tests. */
  reset(): Promise<void>;
}

const HOUSE_DELETED = 'ga.house.v1.HouseDeletedEvent';
const USER_DELETED = 'ga.user.v1.UserDeletedEvent';
const BOOKING = 'booking-service';
const HOUSE = 'house-service';

export function busEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    id: randomUUID(),
    type: HOUSE_DELETED,
    producer: HOUSE,
    aggregateId: randomUUID(),
    occurredAt: new Date('2026-10-23T10:11:12.345Z'),
    requestId: 'req-1',
    traceparent: null,
    payload: Uint8Array.of(10, 2, 104, 49),
    ...overrides,
  };
}

/**
 * The semantics every EventBroker adapter must keep (ADR-0005). A new backend runs this
 * same suite; passing it, not reviewer memory, is what makes backends interchangeable.
 */
export function describeEventBroker(name: string, harness: () => BrokerHarness): void {
  describe(`EventBroker contract: ${name}`, () => {
    let h: BrokerHarness;
    beforeEach(async () => {
      h = harness();
      await h.reset();
    });

    const pullOne = async (subscriber = BOOKING, types = [HOUSE_DELETED]) => {
      const deliveries = await h.broker.pull(subscriber, types, 10);
      expect(deliveries).toHaveLength(1);
      return deliveries[0] as (typeof deliveries)[number];
    };

    it('delivers a published event intact, on its first attempt', async () => {
      const event = busEvent();
      expect(await h.broker.publish(event, [BOOKING])).toBe('accepted');
      const delivery = await pullOne();
      expect(delivery.event).toEqual(event);
      expect(delivery.attempt).toBe(1);
      expect(delivery.publishedAt).toBeInstanceOf(Date);
      expect(delivery.receipt).not.toBe('');
      expect(await h.broker.pull(BOOKING, [HOUSE_DELETED], 10)).toEqual([]);
    });

    it('queues one delivery per subscriber and stores a duplicate once', async () => {
      const event = busEvent({ type: USER_DELETED, producer: 'user-service' });
      expect(await h.broker.publish(event, [HOUSE, BOOKING])).toBe('accepted');
      expect(await h.broker.publish(event, [HOUSE, BOOKING])).toBe('duplicate');
      expect((await pullOne(HOUSE, [USER_DELETED])).event.id).toBe(event.id);
      expect((await pullOne(BOOKING, [USER_DELETED])).event.id).toBe(event.id);
      await h.elapse();
      expect(await h.broker.pull(HOUSE, [USER_DELETED], 10)).toHaveLength(1);
      expect(await h.broker.pull(BOOKING, [USER_DELETED], 10)).toHaveLength(1);
    });

    it('reports an id reused for different content', async () => {
      const event = busEvent();
      await h.broker.publish(event, [BOOKING]);
      expect(await h.broker.publish({ ...event, payload: Uint8Array.of(1) }, [BOOKING])).toBe(
        'reused',
      );
      expect(await h.broker.publish({ ...event, aggregateId: 'other' }, [BOOKING])).toBe('reused');
      expect(await h.broker.publish({ ...event, producer: 'user-service' }, [BOOKING])).toBe(
        'reused',
      );
    });

    it('leases only the requested types, spending no attempts on the others', async () => {
      await h.broker.publish(busEvent(), [BOOKING]);
      expect(await h.broker.pull(BOOKING, [USER_DELETED], 10)).toEqual([]);
      expect((await pullOne()).attempt).toBe(1);
    });

    it('leases at most `max` deliveries per pull', async () => {
      for (let i = 0; i < 5; i += 1) await h.broker.publish(busEvent(), [BOOKING]);
      const ids: string[] = [];
      for (const expected of [2, 2, 1]) {
        const batch = await h.broker.pull(BOOKING, [HOUSE_DELETED], 2);
        expect(batch).toHaveLength(expected);
        ids.push(...batch.map((d) => d.event.id));
      }
      expect(new Set(ids).size).toBe(5);
    });

    it('removes a delivery acked with its current receipt', async () => {
      await h.broker.publish(busEvent(), [BOOKING]);
      await h.broker.ack(BOOKING, [(await pullOne()).receipt]);
      await h.elapse();
      expect(await h.broker.pull(BOOKING, [HOUSE_DELETED], 10)).toEqual([]);
    });

    it('ignores stale, foreign and malformed receipts', async () => {
      await h.broker.publish(busEvent(), [BOOKING]);
      const first = await pullOne();
      await h.elapse();
      const second = await pullOne();
      expect(second.attempt).toBe(2);
      await h.broker.ack(BOOKING, [first.receipt, 'garbage', `${first.event.id}.x`]);
      await h.broker.nack(BOOKING, first.receipt, {
        reason: 'X',
        message: '',
        deadLetter: true,
      });
      await h.broker.ack(HOUSE, [second.receipt]);
      await h.broker.nack(HOUSE, second.receipt, { reason: 'X', message: '', deadLetter: true });
      await h.elapse();
      expect((await pullOne()).attempt).toBe(3);
    });

    it('redelivers a nacked delivery after its backoff, not before', async () => {
      await h.broker.publish(busEvent(), [BOOKING]);
      await h.broker.nack(BOOKING, (await pullOne()).receipt, {
        reason: 'DEPENDENCY_UNAVAILABLE',
        message: 'try later',
        deadLetter: false,
      });
      expect(await h.broker.pull(BOOKING, [HOUSE_DELETED], 10)).toEqual([]);
      await h.elapse();
      expect((await pullOne()).attempt).toBe(2);
    });

    it('redelivers when a lease ends unsettled', async () => {
      await h.broker.publish(busEvent(), [BOOKING]);
      await pullOne();
      expect(await h.broker.pull(BOOKING, [HOUSE_DELETED], 10)).toEqual([]);
      await h.elapse();
      expect((await pullOne()).attempt).toBe(2);
    });

    it('dead-letters when the attempts run out, at a nack or at an expired lease', async () => {
      const nacked = busEvent();
      const crashing = busEvent();
      await h.broker.publish(nacked, [BOOKING]);
      await h.broker.publish(crashing, [BOOKING]);
      for (let attempt = 1; attempt <= h.maxAttempts; attempt += 1) {
        const deliveries = await h.broker.pull(BOOKING, [HOUSE_DELETED], 10);
        expect(deliveries.map((d) => d.attempt)).toEqual([attempt, attempt]);
        const toNack = deliveries.find((d) => d.event.id === nacked.id);
        await h.broker.nack(BOOKING, toNack?.receipt ?? '', {
          reason: 'HANDLER_FAILED',
          message: 'boom',
          deadLetter: false,
        });
        await h.elapse();
      }
      expect(await h.broker.pull(BOOKING, [HOUSE_DELETED], 10)).toEqual([]);
    });

    it('dead-letters at once when asked, and never delivers a dead letter again', async () => {
      await h.broker.publish(busEvent(), [BOOKING]);
      await h.broker.nack(BOOKING, (await pullOne()).receipt, {
        reason: 'EVENT_UNDECODABLE',
        message: 'bad payload',
        deadLetter: true,
      });
      await h.elapse();
      expect(await h.broker.pull(BOOKING, [HOUSE_DELETED], 10)).toEqual([]);
    });

    it('never leases one delivery to two concurrent pulls, nor more than their max', async () => {
      const published = Array.from({ length: 20 }, () => busEvent());
      for (const event of published) await h.broker.publish(event, [BOOKING]);
      const batches = await Promise.all(
        [8, 8, 8].map((max) => h.broker.pull(BOOKING, [HOUSE_DELETED], max)),
      );
      for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(8);
      const ids = batches.flat().map((d) => d.event.id);
      expect(ids).toHaveLength(20);
      expect(new Set(ids).size).toBe(20);
    });

    it('can be provisioned more than once', async () => {
      const subscriptions = [{ subscriber: BOOKING, types: [HOUSE_DELETED] }];
      await h.broker.provision(subscriptions);
      await h.broker.provision(subscriptions);
    });
  });
}
