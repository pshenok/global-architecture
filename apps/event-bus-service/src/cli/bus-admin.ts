import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { subscriptions, topicOf } from '../domain/topics.ts';
import { deliveries, events } from '../infrastructure/persistence/schema.ts';

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

/** Pending and dead deliveries per subscriber and type: the lag dashboard of the CLI. */
export async function status(db: NodePgDatabase): Promise<QueueStatus[]> {
  const rows = await db
    .select({
      subscriber: deliveries.subscriber,
      type: deliveries.type,
      pending: sql<number>`count(*) filter (where ${deliveries.status} = 'PENDING')::int`,
      dead: sql<number>`count(*) filter (where ${deliveries.status} = 'DEAD')::int`,
      oldestPendingS: sql<number>`coalesce(extract(epoch from now() - min(${events.publishedAt}) filter (where ${deliveries.status} = 'PENDING')), 0)::float8`,
    })
    .from(deliveries)
    .innerJoin(events, eq(events.id, deliveries.eventId))
    .groupBy(deliveries.subscriber, deliveries.type)
    .orderBy(deliveries.subscriber, deliveries.type);
  return rows.map((row) => ({
    ...row,
    oldestPendingS: Math.round(row.oldestPendingS),
    orphaned: !listed(row.subscriber, row.type),
  }));
}

/**
 * Dead letters of a subscriber (optionally one type) back to pending, with fresh attempts.
 * Their handler never applied them (the failure rolled its transaction back), so each runs
 * once. Only types the catalog lists for the subscriber: a `type` it does not list is
 * refused, and without one the dead letters of other types are skipped and counted.
 */
export async function redrive(
  db: NodePgDatabase,
  target: { readonly subscriber: string; readonly type?: string | undefined },
): Promise<{ readonly redriven: number; readonly skipped: number }> {
  if (target.type && !listed(target.subscriber, target.type)) {
    throw new Error(`the catalog does not list ${target.subscriber} for ${target.type}`);
  }
  const types = target.type
    ? [target.type]
    : (subscriptions().find((s) => s.subscriber === target.subscriber)?.types ?? []);
  const dead = and(eq(deliveries.subscriber, target.subscriber), eq(deliveries.status, 'DEAD'));
  let skipped = 0;
  if (!target.type) {
    const [unlisted] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveries)
      .where(and(dead, notInArray(deliveries.type, types)));
    skipped = unlisted?.count ?? 0;
  }
  const rows = await db
    .update(deliveries)
    .set({ status: 'PENDING', attempts: 0, availableAt: sql`now()`, leaseToken: null })
    .where(and(dead, inArray(deliveries.type, types)))
    .returning({ eventId: deliveries.eventId });
  return { redriven: rows.length, skipped };
}

/**
 * Queues retained events of a type published since `since` for a subscriber again, e.g.
 * to backfill a new subscriber. Refused unless the catalog lists that subscriber for that
 * type. Events it already holds a delivery for are skipped; ones it already processed are
 * skipped by its processed_events, which remembers them 30 days, longer than retention
 * keeps a delivered event (EVENT_BUS_RETENTION_DAYS, at most 21). The exception is an
 * older event that another subscriber's pending or dead delivery still holds: it can run
 * again.
 */
export async function replay(
  db: NodePgDatabase,
  target: { readonly subscriber: string; readonly type: string; readonly since: Date },
): Promise<number> {
  if (!listed(target.subscriber, target.type)) {
    throw new Error(`the catalog does not list ${target.subscriber} for ${target.type}`);
  }
  const result = await db.execute<{ event_id: string }>(sql`
    insert into deliveries (subscriber, event_id, type, status)
    select ${target.subscriber}, id, type, 'PENDING' from events
    where type = ${target.type} and published_at >= ${target.since}
    on conflict (subscriber, event_id) do nothing
    returning event_id`);
  return result.rows.length;
}

/**
 * Deletes the deliveries, pending or dead, of a pair the catalog no longer lists (a type
 * retired, or a subscriber moved to a v2 type or removed from the topic): nothing can
 * pull or dead-letter them, and they keep their events from retention. Refused while the
 * catalog lists the pair.
 */
export async function drop(
  db: NodePgDatabase,
  target: { readonly subscriber: string; readonly type: string },
): Promise<number> {
  if (listed(target.subscriber, target.type)) {
    throw new Error(`the catalog still lists ${target.subscriber} for ${target.type}`);
  }
  const rows = await db
    .delete(deliveries)
    .where(and(eq(deliveries.subscriber, target.subscriber), eq(deliveries.type, target.type)))
    .returning({ eventId: deliveries.eventId });
  return rows.length;
}
