import { beforeEach, describe, expect, it } from 'vitest';
import type { BusDelivery, EventBroker } from '../src/application/ports/event-broker.ts';
import type { EventBrokerAdmin } from '../src/application/ports/event-broker-admin.ts';
import { busEvent } from './event-broker.contract.ts';

/** What the admin contract needs from a backend under test. */
export interface BrokerAdminHarness {
  /** The same backend's EventBroker, to fill the store. */
  readonly broker: EventBroker;
  readonly admin: EventBrokerAdmin;
  /** Moves the publish time of these events `days` into the past. */
  backdate(eventIds: readonly string[], days: number): Promise<void>;
  /** Empties the store between tests. */
  reset(): Promise<void>;
}

const HOUSE_DELETED = 'ga.house.v1.HouseDeletedEvent';
const USER_DELETED = 'ga.user.v1.UserDeletedEvent';
const BOOKING = 'booking-service';
const HOUSE = 'house-service';
const DAY_MS = 86_400_000;

/**
 * The operator and retention semantics every EventBrokerAdmin adapter must keep
 * (ADR-0005), next to the EventBroker contract. Storage only: the catalog rules are
 * EventBusAdmin's, so these tests may name any pair.
 */
export function describeEventBrokerAdmin(name: string, harness: () => BrokerAdminHarness): void {
  describe(`EventBrokerAdmin contract: ${name}`, () => {
    let h: BrokerAdminHarness;
    beforeEach(async () => {
      h = harness();
      await h.reset();
    });

    const userDeleted = () => busEvent({ type: USER_DELETED, producer: 'user-service' });
    const pullAll = (subscriber: string, type: string) => h.broker.pull(subscriber, [type], 100);
    const leaseOf = (leased: readonly BusDelivery[], id: string) => {
      const delivery = leased.find((d) => d.event.id === id);
      if (!delivery) throw new Error(`event ${id} was not leased`);
      return delivery;
    };
    const kill = (subscriber: string, receipt: string) =>
      h.broker.nack(subscriber, receipt, {
        reason: 'HANDLER_FAILED',
        message: 'boom',
        deadLetter: true,
      });
    const killAll = async (subscriber: string, type: string) => {
      for (const delivery of await pullAll(subscriber, type)) {
        await kill(subscriber, delivery.receipt);
      }
    };

    it('counts pending (leased too) and dead deliveries per subscriber and type', async () => {
      const [dead, old, acked, fresh] = [busEvent(), busEvent(), busEvent(), busEvent()];
      for (const event of [dead, old, acked, fresh]) await h.broker.publish(event, [BOOKING]);
      await h.broker.publish(userDeleted(), [HOUSE, BOOKING]);
      await h.backdate([old.id], 1);
      const leased = await pullAll(BOOKING, HOUSE_DELETED);
      await kill(BOOKING, leaseOf(leased, dead.id).receipt);
      await h.broker.ack(BOOKING, [leaseOf(leased, acked.id).receipt]);
      await killAll(HOUSE, USER_DELETED);
      expect(await h.admin.queues()).toEqual([
        {
          subscriber: BOOKING,
          type: HOUSE_DELETED,
          pending: 2,
          dead: 1,
          oldestPendingPublishedAt: leaseOf(leased, old.id).publishedAt,
        },
        {
          subscriber: BOOKING,
          type: USER_DELETED,
          pending: 1,
          dead: 0,
          oldestPendingPublishedAt: expect.any(Date),
        },
        {
          subscriber: HOUSE,
          type: USER_DELETED,
          pending: 0,
          dead: 1,
          oldestPendingPublishedAt: null,
        },
      ]);
    });

    it('lists nothing once every delivery is settled', async () => {
      await h.broker.publish(busEvent(), [BOOKING]);
      await h.broker.ack(
        BOOKING,
        (await pullAll(BOOKING, HOUSE_DELETED)).map((d) => d.receipt),
      );
      expect(await h.admin.queues()).toEqual([]);
    });

    it('redrives the dead letters of the given types with fresh attempts', async () => {
      const house = busEvent();
      const user = userDeleted();
      await h.broker.publish(house, [BOOKING]);
      await h.broker.publish(user, [BOOKING, HOUSE]);
      await killAll(BOOKING, HOUSE_DELETED);
      await killAll(BOOKING, USER_DELETED);
      await killAll(HOUSE, USER_DELETED);
      expect(await h.admin.redrive(BOOKING, [HOUSE_DELETED])).toBe(1);
      const both = [HOUSE_DELETED, USER_DELETED];
      const again = await h.broker.pull(BOOKING, both, 10);
      expect(again.map((d) => [d.event.id, d.attempt])).toEqual([[house.id, 1]]);
      expect(await h.admin.redrive(BOOKING, [])).toBe(0);
      // The leased house delivery is pending, not dead: only the user one comes back.
      expect(await h.admin.redrive(BOOKING, both)).toBe(1);
      const after = await h.broker.pull(BOOKING, both, 10);
      expect(after.map((d) => [d.event.id, d.attempt])).toEqual([[user.id, 1]]);
      expect(await h.broker.pull(HOUSE, [USER_DELETED], 10)).toEqual([]);
    });

    it('replays stored events of the window to a subscriber holding none of them', async () => {
      const held = userDeleted();
      const [recent, tooOld, beforeSince] = [userDeleted(), userDeleted(), userDeleted()];
      const otherType = busEvent();
      await h.broker.publish(held, [HOUSE, BOOKING]);
      for (const event of [recent, tooOld, beforeSince, otherType]) {
        await h.broker.publish(event, [BOOKING]);
      }
      await h.backdate([recent.id, otherType.id], 1);
      await h.backdate([tooOld.id], 10);
      await h.backdate([beforeSince.id], 40);
      const now = Date.now();
      const window = { since: new Date(now - 30 * DAY_MS), notBefore: new Date(now - 5 * DAY_MS) };
      expect(await h.admin.replay(HOUSE, USER_DELETED, window)).toEqual({ queued: 1, skipped: 1 });
      expect(await h.admin.replay(HOUSE, USER_DELETED, window)).toEqual({ queued: 0, skipped: 1 });
      const replayed = await pullAll(HOUSE, USER_DELETED);
      expect(replayed.map((d) => d.event.id).sort()).toEqual([held.id, recent.id].sort());
      expect(leaseOf(replayed, recent.id)).toMatchObject({ event: recent, attempt: 1 });
    });

    it('bounds a replay by publish time, both bounds included', async () => {
      const [earlier, later] = [userDeleted(), userDeleted()];
      for (const event of [earlier, later]) await h.broker.publish(event, [BOOKING]);
      await h.backdate([earlier.id], 2);
      const leased = await pullAll(BOOKING, USER_DELETED);
      const at = (id: string) => leaseOf(leased, id).publishedAt;
      expect(
        await h.admin.replay(HOUSE, USER_DELETED, { since: at(later.id), notBefore: at(later.id) }),
      ).toEqual({ queued: 1, skipped: 0 });
      expect(
        await h.admin.replay(HOUSE, USER_DELETED, {
          since: at(earlier.id),
          notBefore: at(later.id),
        }),
      ).toEqual({ queued: 0, skipped: 1 });
    });

    it('honours since inside the window, and counts as skipped only events the subscriber lacks', async () => {
      const [dayOld, threeDaysOld, oldHeld, oldMissing] = [
        userDeleted(),
        userDeleted(),
        userDeleted(),
        userDeleted(),
      ];
      for (const event of [dayOld, threeDaysOld, oldMissing]) {
        await h.broker.publish(event, [BOOKING]);
      }
      await h.broker.publish(oldHeld, [BOOKING, HOUSE]);
      await h.backdate([dayOld.id], 1);
      await h.backdate([threeDaysOld.id], 3);
      await h.backdate([oldHeld.id, oldMissing.id], 30);
      const now = Date.now();
      const sinceTwoDays = {
        since: new Date(now - 2 * DAY_MS),
        notBefore: new Date(now - 21 * DAY_MS),
      };
      expect(await h.admin.replay(HOUSE, USER_DELETED, sinceTwoDays)).toEqual({
        queued: 1,
        skipped: 0,
      });
      const everything = { since: new Date(0), notBefore: new Date(now - 21 * DAY_MS) };
      expect(await h.admin.replay(HOUSE, USER_DELETED, everything)).toEqual({
        queued: 1,
        skipped: 1,
      });
      const replayed = await pullAll(HOUSE, USER_DELETED);
      expect(replayed.map((d) => d.event.id).sort()).toEqual(
        [dayOld.id, threeDaysOld.id, oldHeld.id].sort(),
      );
    });

    it('lists queues by subscriber, then type', async () => {
      await h.broker.publish(userDeleted(), [BOOKING]);
      await h.broker.publish(busEvent(), [HOUSE]);
      expect((await h.admin.queues()).map((q) => [q.subscriber, q.type])).toEqual([
        [BOOKING, USER_DELETED],
        [HOUSE, HOUSE_DELETED],
      ]);
    });

    it('drops the deliveries of one pair, pending and dead', async () => {
      const [dead, pending] = [busEvent(), busEvent()];
      for (const event of [dead, pending]) await h.broker.publish(event, [BOOKING]);
      await h.broker.publish(userDeleted(), [BOOKING, HOUSE]);
      await kill(BOOKING, leaseOf(await pullAll(BOOKING, HOUSE_DELETED), dead.id).receipt);
      expect(await h.admin.drop(BOOKING, HOUSE_DELETED)).toBe(2);
      expect(await h.admin.drop(BOOKING, HOUSE_DELETED)).toBe(0);
      expect((await h.admin.queues()).map((q) => [q.subscriber, q.type])).toEqual([
        [BOOKING, USER_DELETED],
        [HOUSE, USER_DELETED],
      ]);
    });

    it('purges events past the age that no delivery holds, keeping pending and dead ones', async () => {
      const [delivered, dead, recent, pending] = [busEvent(), busEvent(), busEvent(), busEvent()];
      for (const event of [delivered, dead, recent]) await h.broker.publish(event, [BOOKING]);
      const leased = await pullAll(BOOKING, HOUSE_DELETED);
      await h.broker.ack(BOOKING, [
        leaseOf(leased, delivered.id).receipt,
        leaseOf(leased, recent.id).receipt,
      ]);
      await kill(BOOKING, leaseOf(leased, dead.id).receipt);
      await h.broker.publish(pending, [BOOKING]);
      await h.backdate([delivered.id, dead.id, pending.id], 8);
      expect(await h.admin.purgeDelivered(9)).toBe(0);
      expect(await h.admin.purgeDelivered(7)).toBe(1);
      expect(await h.admin.purgeDelivered(7)).toBe(0);
      // What is left can still be delivered: replay it all to another subscriber.
      const all = { since: new Date(0), notBefore: new Date(0) };
      expect(await h.admin.replay(HOUSE, HOUSE_DELETED, all)).toEqual({ queued: 3, skipped: 0 });
      const left = await pullAll(HOUSE, HOUSE_DELETED);
      expect(left.map((d) => d.event.id).sort()).toEqual([dead.id, recent.id, pending.id].sort());
      expect(await h.admin.redrive(BOOKING, [HOUSE_DELETED])).toBe(1);
    });
  });
}
