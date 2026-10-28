import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import { DbContext } from '../database/db-context.ts';
import type { EventsConfig } from './config.ts';
import { EventBusClient, type PublishStatus } from './event-bus.client.ts';
import { outbox } from './tables.ts';
import { EVENTS_CONFIG } from './tokens.ts';

/** Rows claimed and published per round. */
export const RELAY_BATCH = 50;
/** A claimed row is this relay's for this long; then any relay may claim it again. */
const LEASE = sql`now() + interval '30 seconds'`;
/** From this attempt on, a row that keeps failing is logged as an error. */
const LOUD_FROM_ATTEMPT = 10;

type Row = typeof outbox.$inferSelect;

/** Wait before a row is tried again: 1 s, 2 s, 4 s ... at most 5 minutes. */
const backoffS = (attempts: number) => Math.min(2 ** Math.max(0, attempts - 1), 300);

/**
 * Publishes outbox rows to event-bus-service, at least once (ADR-0005). Each round
 * claims due rows in one autocommitted statement, sends ONE Publish with no transaction
 * open, then settles each row by its lease token: published rows are deleted, refused
 * or unavailable ones wait out a backoff. Rows never block each other and are never
 * dropped; several replicas share the work (SKIP LOCKED).
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRelay');
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  private failures = 0;

  constructor(
    private readonly db: DbContext,
    private readonly bus: EventBusClient,
    private readonly cls: ClsService,
    @Inject(EVENTS_CONFIG) private readonly config: EventsConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.EVENTS_AUTOSTART) this.schedule(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await drain(this.inFlight, this.config.EVENTS_DRAIN_MS, () =>
      this.logger.warn('stopped with a publish in flight; its rows go out after the next start'),
    );
  }

  /**
   * One round; returns how many rows it claimed. In a fresh request context, so no
   * user's principal or request id can ride along on Publish.
   */
  flush(): Promise<number> {
    return this.cls.run({ ifNested: 'override' }, async () => {
      const rows = await this.claim();
      if (rows.length === 0) return 0;
      let statuses: readonly PublishStatus[];
      try {
        statuses = await this.bus.publish(
          rows.map((row) => ({
            id: row.id,
            type: row.type,
            aggregateId: row.aggregateId,
            occurredAt: row.occurredAt,
            payload: row.payload,
            requestId: row.requestId,
            traceparent: row.traceparent,
          })),
        );
      } catch (error) {
        this.logger.warn(`cannot publish ${rows.length} event(s): ${String(error)}`);
        await this.backOff(rows.map((row) => ({ row, error: `PUBLISH_FAILED: ${String(error)}` })));
        return rows.length;
      }
      const byId = new Map(statuses.map((status) => [status.eventId, status]));
      const published: Row[] = [];
      const failed: { row: Row; error: string }[] = [];
      for (const row of rows) {
        const status = byId.get(row.id);
        if (status?.outcome === 'ACCEPTED' || status?.outcome === 'DUPLICATE') {
          published.push(row);
          continue;
        }
        const error = status ? `${status.outcome} ${status.reason}` : 'NO_RESULT';
        failed.push({ row, error });
        const line = `event ${row.id} (${row.type}) not published, attempt ${row.attempts}: ${error}`;
        if (status?.outcome === 'REJECTED' || row.attempts >= LOUD_FROM_ATTEMPT) {
          this.logger.error(line);
        } else {
          this.logger.warn(line);
        }
      }
      await this.settle(published);
      await this.backOff(failed);
      return rows.length;
    });
  }

  private claim(): Promise<Row[]> {
    const due = this.db.tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(lte(outbox.availableAt, sql`now()`))
      .orderBy(outbox.availableAt, outbox.id)
      .limit(RELAY_BATCH)
      .for('update', { skipLocked: true });
    return this.db.tx
      .update(outbox)
      .set({
        attempts: sql`${outbox.attempts} + 1`,
        availableAt: LEASE,
        leaseToken: sql`gen_random_uuid()`,
      })
      .where(inArray(outbox.id, due))
      .returning();
  }

  /** Deletes published rows, unless another relay claimed them since (lease token). */
  private async settle(rows: readonly Row[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.tx.delete(outbox).where(or(...rows.map((row) => leased(row))));
  }

  private async backOff(failed: readonly { row: Row; error: string }[]): Promise<void> {
    for (const { row, error } of failed) {
      await this.db.tx
        .update(outbox)
        .set({
          availableAt: sql`now() + make_interval(secs => ${backoffS(row.attempts)})`,
          leaseToken: null,
          lastError: error.slice(0, 1000),
        })
        .where(leased(row));
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.round();
    }, delayMs);
    this.timer.unref();
  }

  private async round(): Promise<void> {
    let claimed = 0;
    try {
      claimed = await this.flush();
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      if (this.failures === 1 || this.failures % 20 === 0) {
        this.logger.warn(`outbox round failed (${this.failures} in a row): ${String(error)}`);
      }
    }
    const idle = Math.min(this.config.EVENTS_POLL_MS * 2 ** this.failures, 30_000);
    this.schedule(claimed === RELAY_BATCH ? 0 : idle);
  }
}

/** The row as this relay claimed it: matches nothing once another relay has claimed it. */
const leased = (row: Row) =>
  row.leaseToken === null
    ? sql`false`
    : and(eq(outbox.id, row.id), eq(outbox.leaseToken, row.leaseToken));

/** Waits for `work`, at most `ms`; calls `onTimeout` when it gives up. */
export async function drain(
  work: Promise<unknown> | undefined,
  ms: number,
  onTimeout: () => void,
): Promise<void> {
  if (!work) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  const done = work.then(
    () => 'done' as const,
    () => 'done' as const,
  );
  const result = await Promise.race([done, timeout]);
  clearTimeout(timer);
  if (result === 'timeout') onTimeout();
}
