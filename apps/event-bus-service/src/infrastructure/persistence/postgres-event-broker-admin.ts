import type { Database } from '@ga/service-kit';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  EventBrokerAdmin,
  type QueueStats,
  type ReplayResult,
  type ReplayWindow,
} from '../../application/ports/event-broker-admin.ts';
import { deliveries, events, leasableNow } from './schema.ts';

const PURGE_BATCH = 1_000;

/**
 * EventBrokerAdmin on the tables of PostgresEventBroker. It takes a Drizzle database, so
 * the CLI builds it from a pool without booting the service; no decorators or parameter
 * properties, so the CLI can run unbuilt. Ages use the database clock.
 */
export class PostgresEventBrokerAdmin extends EventBrokerAdmin {
  private readonly db: Database;

  constructor(db: Database) {
    super();
    this.db = db;
  }

  async queues(): Promise<readonly QueueStats[]> {
    const pending = sql`${deliveries.status} = 'PENDING'`;
    return this.db
      .select({
        subscriber: deliveries.subscriber,
        type: deliveries.type,
        pending: sql<number>`count(*) filter (where ${pending})::int`,
        dead: sql<number>`count(*) filter (where ${deliveries.status} = 'DEAD')::int`,
        oldestPendingPublishedAt:
          sql<Date | null>`min(${events.publishedAt}) filter (where ${pending})`.mapWith(
            events.publishedAt,
          ),
      })
      .from(deliveries)
      .innerJoin(events, eq(events.id, deliveries.eventId))
      .groupBy(deliveries.subscriber, deliveries.type)
      .orderBy(deliveries.subscriber, deliveries.type);
  }

  async redrive(subscriber: string, types: readonly string[]): Promise<number> {
    if (types.length === 0) return 0;
    const rows = await this.db
      .update(deliveries)
      .set({ status: 'PENDING', attempts: 0, availableAt: leasableNow, leaseToken: null })
      .where(
        and(
          eq(deliveries.subscriber, subscriber),
          eq(deliveries.status, 'DEAD'),
          inArray(deliveries.type, types),
        ),
      )
      .returning({ eventId: deliveries.eventId });
    return rows.length;
  }

  async replay(subscriber: string, type: string, window: ReplayWindow): Promise<ReplayResult> {
    const { since, notBefore } = window;
    const result = await this.db.execute<{ event_id: string }>(sql`
      insert into deliveries (subscriber, event_id, type, status, available_at)
      select ${subscriber}, id, type, 'PENDING', ${leasableNow} from events
      where type = ${type} and published_at >= ${since} and published_at >= ${notBefore}
      on conflict (subscriber, event_id) do nothing
      returning event_id`);
    const old = await this.db.execute<{ count: number }>(sql`
      select count(*)::int as count from events e
      where e.type = ${type} and e.published_at >= ${since} and e.published_at < ${notBefore}
        and not exists (select 1 from deliveries d
          where d.subscriber = ${subscriber} and d.event_id = e.id)`);
    return { queued: result.rows.length, skipped: old.rows[0]?.count ?? 0 };
  }

  async drop(subscriber: string, type: string): Promise<number> {
    const rows = await this.db
      .delete(deliveries)
      .where(and(eq(deliveries.subscriber, subscriber), eq(deliveries.type, type)))
      .returning({ eventId: deliveries.eventId });
    return rows.length;
  }

  /**
   * In batches of 1000; one replica at a time (advisory lock), the others return 0. The
   * lock is per schema, like migrations in tests, so test schemas never block each other.
   */
  async purgeDelivered(olderThanDays: number): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.db.transaction(async (tx) => {
        const lock = await tx.execute<{ locked: boolean }>(sql`
          select pg_try_advisory_xact_lock(hashtext('event-bus:retention:' || current_schema()))
            as locked`);
        if (lock.rows[0]?.locked !== true) return 0;
        const result = await tx.execute<{ id: string }>(sql`
          delete from events where id in (
            select e.id from events e
            where e.published_at < now() - make_interval(days => ${olderThanDays})
              and not exists (select 1 from deliveries d where d.event_id = e.id)
            limit ${PURGE_BATCH})
          returning id`);
        return result.rows.length;
      });
      total += deleted;
      if (deleted < PURGE_BATCH) return total;
    }
  }
}
