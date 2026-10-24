import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { topicOf } from '../domain/topics.ts';
import { deliveries, events } from '../infrastructure/persistence/schema.ts';

export interface QueueStatus {
  readonly subscriber: string;
  readonly type: string;
  readonly pending: number;
  readonly dead: number;
  /** Seconds since the oldest pending delivery's event was published; 0 when none. */
  readonly oldestPendingS: number;
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
  return rows.map((row) => ({ ...row, oldestPendingS: Math.round(row.oldestPendingS) }));
}

/** Dead letters of a subscriber (optionally one type) back to pending, with fresh attempts. */
export async function redrive(
  db: NodePgDatabase,
  target: { readonly subscriber: string; readonly type?: string | undefined },
): Promise<number> {
  const rows = await db
    .update(deliveries)
    .set({ status: 'PENDING', attempts: 0, availableAt: sql`now()`, leaseToken: null })
    .where(
      and(
        eq(deliveries.subscriber, target.subscriber),
        eq(deliveries.status, 'DEAD'),
        target.type ? eq(deliveries.type, target.type) : undefined,
      ),
    )
    .returning({ eventId: deliveries.eventId });
  return rows.length;
}

/**
 * Queues retained events of a type published since `since` for a subscriber again, e.g.
 * to backfill a new subscriber. Refused unless the catalog lists that subscriber for that
 * type. Events it already holds a delivery for are skipped; ones it already processed
 * are dropped by its processed_events.
 */
export async function replay(
  db: NodePgDatabase,
  target: { readonly subscriber: string; readonly type: string; readonly since: Date },
): Promise<number> {
  if (!topicOf(target.type)?.subscribers.includes(target.subscriber)) {
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
