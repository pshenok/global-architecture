import { Clock } from '@ga/kernel';
import { subscriptionNotListed, subscriptionStillListed } from '../domain/event-bus.errors.ts';
import { MAX_RETENTION_DAYS } from '../domain/retention.ts';
import { subscriptions, topicOf } from '../domain/topics.ts';
import { EventBrokerAdmin, type ReplayResult } from './ports/event-broker-admin.ts';

const DAY_MS = 86_400_000;

export interface QueueStatus {
  readonly subscriber: string;
  readonly type: string;
  readonly pending: number;
  readonly dead: number;
  /** Seconds since the oldest pending delivery's event was published; 0 when none. */
  readonly oldestPendingS: number;
  /** The catalog no longer lists this pair: nothing pulls these rows, `drop` removes them. */
  readonly orphaned: boolean;
}

function listed(subscriber: string, type: string): boolean {
  return topicOf(type)?.subscribers.includes(subscriber) ?? false;
}

/**
 * The operator commands of the bus (`pnpm events:*`): catalog rules, the same for every
 * backend, over EventBrokerAdmin. A plain class without parameter properties, not a Nest
 * provider: the CLI builds it without booting the service and can run unbuilt.
 */
export class EventBusAdmin {
  private readonly broker: EventBrokerAdmin;
  private readonly clock: Clock;

  constructor(broker: EventBrokerAdmin, clock: Clock) {
    this.broker = broker;
    this.clock = clock;
  }

  /** Pending and dead deliveries per subscriber and type: the lag dashboard of the CLI. */
  async status(): Promise<QueueStatus[]> {
    const now = this.clock.now().getTime();
    return (await this.broker.queues()).map(({ oldestPendingPublishedAt, ...queue }) => ({
      ...queue,
      oldestPendingS: oldestPendingPublishedAt
        ? Math.max(0, Math.round((now - oldestPendingPublishedAt.getTime()) / 1000))
        : 0,
      orphaned: !listed(queue.subscriber, queue.type),
    }));
  }

  /**
   * Dead letters of a subscriber (optionally one type) back to pending, with fresh attempts.
   * A failed handler rolled its transaction back, so that dead letter runs once. One that
   * died by lease expiry (LEASE_EXPIRED) may have been applied: the consumer acks a batch
   * only at its end, so the batch-mates of a delivery that crashes the process commit but
   * are never acked. Its processed_events skips such an event only while it remembers the
   * id (30 days). Only types the catalog lists for the subscriber: a `type` it does not list
   * (or '') is refused, and without one the dead letters of other types are skipped and
   * counted.
   */
  async redrive(target: {
    readonly subscriber: string;
    readonly type?: string | undefined;
  }): Promise<{ readonly redriven: number; readonly skipped: number }> {
    const { subscriber, type } = target;
    if (type !== undefined) {
      if (!listed(subscriber, type)) throw subscriptionNotListed(subscriber, type);
      return { redriven: await this.broker.redrive(subscriber, [type]), skipped: 0 };
    }
    const types = subscriptions().find((s) => s.subscriber === subscriber)?.types ?? [];
    const skipped = (await this.broker.queues())
      .filter((queue) => queue.subscriber === subscriber && !types.includes(queue.type))
      .reduce((sum, queue) => sum + queue.dead, 0);
    return { redriven: await this.broker.redrive(subscriber, types), skipped };
  }

  /**
   * Queues retained events of a type published since `since` for a subscriber again, e.g.
   * to backfill a new subscriber. Refused unless the catalog lists that subscriber for that
   * type. Events it already holds a delivery for are skipped; ones it already processed are
   * skipped by its processed_events, which remembers them PROCESSED_EVENTS_KEPT_DAYS (30).
   * Only events published in the last MAX_RETENTION_DAYS (21) are queued: retention keeps
   * an older one while another subscriber's delivery holds it, and this subscriber may have
   * forgotten it. Those are skipped and counted. The window is checked when queuing, so run
   * it while the subscriber consumes: a replayed delivery still unprocessed 9 days later
   * (30 - 21) could run its handler twice.
   */
  async replay(target: {
    readonly subscriber: string;
    readonly type: string;
    readonly since: Date;
  }): Promise<ReplayResult> {
    const { subscriber, type, since } = target;
    if (!listed(subscriber, type)) throw subscriptionNotListed(subscriber, type);
    const notBefore = new Date(this.clock.now().getTime() - MAX_RETENTION_DAYS * DAY_MS);
    return this.broker.replay(subscriber, type, { since, notBefore });
  }

  /**
   * Deletes the deliveries, pending or dead, of a pair the catalog no longer lists (a type
   * retired, or a subscriber moved to a v2 type or removed from the topic): nothing leases
   * or redrives them (the subscriber's next pull still turns one whose last lease ran out
   * DEAD), and they keep their events from retention. Refused while the catalog lists the
   * pair.
   */
  async drop(target: { readonly subscriber: string; readonly type: string }): Promise<number> {
    const { subscriber, type } = target;
    if (listed(subscriber, type)) throw subscriptionStillListed(subscriber, type);
    return this.broker.drop(subscriber, type);
  }
}
