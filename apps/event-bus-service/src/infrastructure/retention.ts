import { UnitOfWork } from '@ga/kernel';
import { DbContext, InjectConfig } from '@ga/service-kit';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Config } from '../config.ts';

const EVERY_MS = 10 * 60_000;
const BATCH = 1_000;

/**
 * Deletes fully delivered events older than EVENT_BUS_RETENTION_DAYS, every 10 minutes,
 * in batches. Events that still have a delivery (pending or dead) are kept, so a dead
 * letter can always be redriven. One replica purges at a time (advisory lock).
 */
@Injectable()
export class EventRetention implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EventRetention.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: DbContext,
    private readonly unitOfWork: UnitOfWork,
    @InjectConfig() private readonly config: Config,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.running = this.purge().catch((error: unknown) =>
        this.logger.warn(`retention failed: ${String(error)}`),
      );
    }, EVERY_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** One full pass; returns how many events it deleted (0 when another replica holds the lock). */
  async purge(): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.unitOfWork.run(async () => {
        const lock = await this.db.tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtext('event-bus:retention')) as locked`,
        );
        if (lock.rows[0]?.locked !== true) return 0;
        const result = await this.db.tx.execute<{ id: string }>(sql`
          delete from events where id in (
            select e.id from events e
            where e.published_at < now() - make_interval(days => ${this.config.EVENT_BUS_RETENTION_DAYS})
              and not exists (select 1 from deliveries d where d.event_id = e.id)
            limit ${BATCH})
          returning id`);
        return result.rows.length;
      });
      total += deleted;
      if (deleted < BATCH) break;
    }
    if (total > 0) this.logger.log(`deleted ${total} delivered event(s) past retention`);
    return total;
  }
}
