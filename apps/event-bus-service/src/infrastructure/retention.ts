import { InjectConfig } from '@ga/service-kit';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { EventBrokerAdmin } from '../application/ports/event-broker-admin.ts';
import type { Config } from '../config.ts';

const EVERY_MS = 10 * 60_000;

/**
 * Deletes fully delivered events older than EVENT_BUS_RETENTION_DAYS, every 10 minutes.
 * Events that still have a delivery (pending or dead) are kept, so a dead letter can
 * always be redriven. The broker lets one replica purge at a time.
 */
@Injectable()
export class EventRetention implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EventRetention.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly admin: EventBrokerAdmin,
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

  /** One full pass; returns how many events it deleted (0 while another replica purges). */
  async purge(): Promise<number> {
    const total = await this.admin.purgeDelivered(this.config.EVENT_BUS_RETENTION_DAYS);
    if (total > 0) this.logger.log(`deleted ${total} delivered event(s) past retention`);
    return total;
  }
}
