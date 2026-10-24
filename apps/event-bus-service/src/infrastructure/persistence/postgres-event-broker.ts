import { UnitOfWork } from '@ga/kernel';
import { DbContext, InjectConfig } from '@ga/service-kit';
import { Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import {
  type BusDelivery,
  type BusEvent,
  type DeliveryFailure,
  EventBroker,
  type PublishResult,
} from '../../application/ports/event-broker.ts';
import type { Config } from '../../config.ts';
import { retryDelayMs } from '../../domain/retry.ts';
import { deliveries, events } from './schema.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A receipt is `<event id>.<lease token>`; anything else settles nothing. */
function parseReceipt(receipt: string): { eventId: string; token: string } | undefined {
  const [eventId, token, ...rest] = receipt.split('.');
  return eventId && token && rest.length === 0 && UUID.test(eventId) && UUID.test(token)
    ? { eventId, token }
    : undefined;
}

/**
 * EventBroker on the bus's own Postgres database (the default backend). Leases use
 * FOR UPDATE SKIP LOCKED, so several bus replicas share the queue; all time arithmetic
 * uses the database clock.
 */
@Injectable()
export class PostgresEventBroker extends EventBroker {
  constructor(
    private readonly db: DbContext,
    private readonly unitOfWork: UnitOfWork,
    @InjectConfig() private readonly config: Config,
  ) {
    super();
  }

  /** Nothing to create: the tables come from this service's migrations. */
  async provision(): Promise<void> {}

  publish(event: BusEvent, subscribers: readonly string[]): Promise<PublishResult> {
    const payload = Buffer.from(event.payload);
    return this.unitOfWork.run(async () => {
      const inserted = await this.db.tx
        .insert(events)
        .values({
          id: event.id,
          type: event.type,
          producer: event.producer,
          aggregateId: event.aggregateId,
          occurredAt: event.occurredAt,
          requestId: event.requestId,
          traceparent: event.traceparent,
          payload,
        })
        .onConflictDoNothing({ target: events.id })
        .returning({ id: events.id });
      if (inserted.length > 0) {
        if (subscribers.length > 0) {
          await this.db.tx.insert(deliveries).values(
            subscribers.map((subscriber) => ({
              subscriber,
              eventId: event.id,
              type: event.type,
              status: 'PENDING' as const,
            })),
          );
        }
        return 'accepted';
      }
      const [stored] = await this.db.tx.select().from(events).where(eq(events.id, event.id));
      const same =
        stored?.type === event.type &&
        stored.producer === event.producer &&
        stored.aggregateId === event.aggregateId &&
        stored.payload.equals(payload);
      return same ? 'duplicate' : 'reused';
    });
  }

  pull(subscriber: string, types: readonly string[], max: number): Promise<readonly BusDelivery[]> {
    return this.unitOfWork.run(async () => {
      // A lease that ended unsettled on the last attempt: the consumer keeps crashing on it.
      await this.db.tx
        .update(deliveries)
        .set({
          status: 'DEAD',
          leaseToken: null,
          lastError: 'LEASE_EXPIRED: the last lease ended without an ack or a nack',
        })
        .where(
          and(
            eq(deliveries.subscriber, subscriber),
            eq(deliveries.status, 'PENDING'),
            gte(deliveries.attempts, this.config.EVENT_BUS_MAX_ATTEMPTS),
            lte(deliveries.availableAt, sql`now()`),
          ),
        );
      const typeList = sql.join(
        types.map((type) => sql`${type}`),
        sql`, `,
      );
      const leased = await this.db.tx.execute<{
        event_id: string;
        attempts: number;
        lease_token: string;
      }>(sql`
        with next as (
          select event_id from deliveries
          where subscriber = ${subscriber} and status = 'PENDING' and type in (${typeList})
            and available_at <= now()
          order by available_at, event_id
          limit ${max}
          for update skip locked
        )
        update deliveries d
        set attempts = d.attempts + 1,
            available_at = now() + make_interval(secs => ${this.config.EVENT_BUS_LEASE_S}),
            lease_token = gen_random_uuid()
        from next
        where d.subscriber = ${subscriber} and d.event_id = next.event_id
        returning d.event_id, d.attempts, d.lease_token`);
      if (leased.rows.length === 0) return [];
      const stored = await this.db.tx
        .select()
        .from(events)
        .where(
          inArray(
            events.id,
            leased.rows.map((row) => row.event_id),
          ),
        );
      const byId = new Map(stored.map((row) => [row.id, row]));
      return leased.rows.flatMap((lease) => {
        const row = byId.get(lease.event_id);
        if (!row) return [];
        const delivery: BusDelivery = {
          event: {
            id: row.id,
            type: row.type,
            producer: row.producer,
            aggregateId: row.aggregateId,
            occurredAt: row.occurredAt,
            requestId: row.requestId,
            traceparent: row.traceparent,
            payload: new Uint8Array(row.payload),
          },
          publishedAt: row.publishedAt,
          attempt: lease.attempts,
          receipt: `${row.id}.${lease.lease_token}`,
        };
        return [delivery];
      });
    });
  }

  async ack(subscriber: string, receipts: readonly string[]): Promise<void> {
    const leases = receipts.flatMap((receipt) => parseReceipt(receipt) ?? []);
    if (leases.length === 0) return;
    await this.db.tx
      .delete(deliveries)
      .where(
        and(
          eq(deliveries.subscriber, subscriber),
          eq(deliveries.status, 'PENDING'),
          or(
            ...leases.map(({ eventId, token }) =>
              and(eq(deliveries.eventId, eventId), eq(deliveries.leaseToken, token)),
            ),
          ),
        ),
      );
  }

  async nack(subscriber: string, receipt: string, failure: DeliveryFailure): Promise<void> {
    const lease = parseReceipt(receipt);
    if (!lease) return;
    const current = and(
      eq(deliveries.subscriber, subscriber),
      eq(deliveries.eventId, lease.eventId),
      eq(deliveries.leaseToken, lease.token),
      eq(deliveries.status, 'PENDING'),
    );
    await this.unitOfWork.run(async () => {
      const [row] = await this.db.tx
        .select({ attempts: deliveries.attempts })
        .from(deliveries)
        .where(current)
        .for('update');
      if (!row) return;
      const dead = failure.deadLetter || row.attempts >= this.config.EVENT_BUS_MAX_ATTEMPTS;
      await this.db.tx
        .update(deliveries)
        .set({
          status: dead ? 'DEAD' : 'PENDING',
          availableAt: sql`now() + make_interval(secs => ${retryDelayMs(row.attempts) / 1000})`,
          leaseToken: null,
          lastError: `${failure.reason}: ${failure.message}`.slice(0, 1000),
        })
        .where(current);
    });
  }
}
