import { type MessageCodec, messageCodec } from '@ga/contracts/runtime';
import { UnitOfWork } from '@ga/kernel';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { enterEventDelivery } from '../auth/principal-context.ts';
import { DbContext } from '../database/db-context.ts';
import { SERVICE_DEFINITION, type ServiceDefinition } from '../platform/service-definition.ts';
import type { EventsConfig } from './config.ts';
import { EventBusClient, type WireDelivery } from './event-bus.client.ts';
import type { EventType } from './event-type.ts';
import { classifyFailure } from './failure.ts';
import { handledEventOf } from './on-event.ts';
import { drain } from './outbox-relay.ts';
import { processedEvents } from './tables.ts';
import { EVENTS_CONFIG } from './tokens.ts';

/** Deliveries leased per pull; processed one after another. */
export const CONSUMER_BATCH = 10;
const PURGE_EVERY_MS = 60 * 60_000;
/**
 * Longer than the bus's EVENT_BUS_RETENTION_DAYS (capped at 21) plus its ~14 minute retry
 * window, so a redelivered or replayed event is skipped. Raise that cap only together
 * with this.
 */
const PROCESSED_EVENTS_KEPT = sql`interval '30 days'`;

/** What became of one delivery: acked, or nacked with a reason to retry or dead-letter. */
export type DeliveryOutcome =
  | 'applied'
  | 'duplicate'
  | { readonly retry: string; readonly message: string }
  | { readonly dead: string; readonly message: string };

interface Handler {
  readonly event: EventType<object>;
  readonly member: string;
  readonly codec: MessageCodec;
  readonly invoke: (payload: Readonly<Record<string, unknown>>) => Promise<void>;
}

/**
 * Runs this service's @OnEvent handlers (ADR-0005). Pulls the handled types from
 * event-bus-service and processes each delivery in a fresh request context that acts as
 * this service itself (currentService(), currentEvent()), inside one transaction that
 * first records the event id in processed_events: a redelivered event is skipped, and a
 * failed handler leaves nothing behind. Successes are acked in one batch; each failure
 * is nacked to retry or to dead-letter (classifyFailure).
 */
@Injectable()
export class EventConsumer implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('EventConsumer');
  private readonly handlers = new Map<string, Handler>();
  private timer: NodeJS.Timeout | undefined;
  private purgeTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  private failures = 0;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly db: DbContext,
    private readonly unitOfWork: UnitOfWork,
    private readonly bus: EventBusClient,
    private readonly cls: ClsService,
    @Inject(SERVICE_DEFINITION) private readonly service: ServiceDefinition,
    @Inject(EVENTS_CONFIG) private readonly config: EventsConfig,
  ) {}

  /** Finds the handlers; fails boot on two handlers of one type or a payload that does not exist. */
  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (!instance || typeof instance !== 'object' || !wrapper.isDependencyTreeStatic()) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!prototype) continue;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const method = prototype[name];
        const event = handledEventOf(method);
        if (!event) continue;
        const member = `${instance.constructor.name}.${name}`;
        const existing = this.handlers.get(event.type);
        if (existing) {
          throw new Error(`two handlers of ${event.type}: ${existing.member} and ${member}`);
        }
        const invoke = method as (this: object, payload: unknown) => Promise<void>;
        this.handlers.set(event.type, {
          event,
          member,
          codec: messageCodec(event.protoFile, event.type),
          invoke: (payload) => invoke.call(instance, payload),
        });
      }
    }
    if (this.handlers.size === 0) {
      this.logger.warn('EventsModule consumes, but no provider has an @OnEvent handler');
    }
  }

  onApplicationBootstrap(): void {
    if (!this.config.EVENTS_AUTOSTART || this.handlers.size === 0) return;
    this.schedule(0);
    this.purgeTimer = setInterval(() => {
      this.purge().catch((error: unknown) =>
        this.logger.warn(`cannot purge processed_events: ${String(error)}`),
      );
    }, PURGE_EVERY_MS);
    this.purgeTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.purgeTimer);
    await drain(this.inFlight, this.config.EVENTS_DRAIN_MS, () =>
      this.logger.warn('stopped with a delivery in flight; the bus redelivers it after its lease'),
    );
  }

  /** One pull and its deliveries; returns how many deliveries it got. */
  async pollOnce(): Promise<number> {
    const deliveries = await this.cls.run({ ifNested: 'override' }, () =>
      this.bus.pull([...this.handlers.keys()], CONSUMER_BATCH),
    );
    const settled: string[] = [];
    for (const delivery of deliveries) {
      if (this.stopped) break;
      const outcome = await this.process(delivery);
      if (outcome === 'applied' || outcome === 'duplicate') {
        settled.push(delivery.receipt);
        continue;
      }
      const failure =
        'dead' in outcome
          ? { reason: outcome.dead, message: outcome.message, deadLetter: true }
          : { reason: outcome.retry, message: outcome.message, deadLetter: false };
      await this.cls.run({ ifNested: 'override' }, () => this.bus.nack(delivery.receipt, failure));
    }
    if (settled.length > 0) {
      await this.cls.run({ ifNested: 'override' }, () => this.bus.ack(settled));
    }
    return deliveries.length;
  }

  /**
   * Processes one delivery exactly once in effect. Never throws: the outcome says
   * whether to ack ('applied', 'duplicate'), retry or dead-letter.
   */
  process(delivery: WireDelivery): Promise<DeliveryOutcome> {
    const { event } = delivery;
    return this.cls.run({ ifNested: 'override' }, () => {
      this.cls.set(CLS_ID, event.requestId ?? `evt-${event.id}`);
      enterEventDelivery(this.cls, this.service.name, {
        id: event.id,
        type: event.type,
        producer: delivery.producer,
        aggregateId: event.aggregateId,
        occurredAt: event.occurredAt,
        attempt: delivery.attempt,
      });
      const trace = event.traceparent
        ? propagation.extract(ROOT_CONTEXT, { traceparent: event.traceparent })
        : ROOT_CONTEXT;
      return context.with(trace, () => this.handle(delivery));
    });
  }

  private async handle(delivery: WireDelivery): Promise<DeliveryOutcome> {
    const { event } = delivery;
    const handler = this.handlers.get(event.type);
    const refuse = (reason: string, detail: string): DeliveryOutcome => {
      const message = detail.slice(0, 1000);
      this.logger.error(`dead-lettered ${event.type} ${event.id}: ${reason}: ${message}`);
      return { dead: reason, message };
    };
    if (!handler) return refuse('EVENT_TYPE_NOT_HANDLED', 'no @OnEvent handler');
    if (delivery.producer !== handler.event.producer) {
      return refuse('UNEXPECTED_PRODUCER', `published by ${delivery.producer}`);
    }
    let payload: Readonly<Record<string, unknown>>;
    try {
      payload = handler.codec.decode(event.payload);
    } catch (error) {
      return refuse('EVENT_UNDECODABLE', String(error));
    }
    try {
      const applied = await this.unitOfWork.run(async () => {
        const recorded = await this.db.tx
          .insert(processedEvents)
          .values({ subscription: this.service.name, eventId: event.id, type: event.type })
          .onConflictDoNothing()
          .returning({ eventId: processedEvents.eventId });
        if (recorded.length === 0) return false;
        await handler.invoke(payload);
        return true;
      });
      return applied ? 'applied' : 'duplicate';
    } catch (error) {
      const failure = classifyFailure(error);
      if (failure.action === 'dead') return refuse(failure.reason, failure.message);
      this.logger.warn(
        `${handler.member} failed on ${event.id} (attempt ${delivery.attempt}), will retry: ${failure.reason}: ${failure.message}`,
      );
      return { retry: failure.reason, message: failure.message };
    }
  }

  /** Forgets processed events older than 30 days, in batches. */
  private async purge(): Promise<void> {
    for (;;) {
      const deleted = await this.db.tx.execute<{ event_id: string }>(sql`
        delete from processed_events where ctid in (
          select ctid from processed_events
          where processed_at < now() - ${PROCESSED_EVENTS_KEPT} limit 1000)
        returning event_id`);
      if (deleted.rows.length < 1000) return;
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
    let received = 0;
    try {
      received = await this.pollOnce();
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      if (this.failures === 1 || this.failures % 20 === 0) {
        this.logger.warn(`event pull failed (${this.failures} in a row): ${String(error)}`);
      }
    }
    const idle = Math.min(this.config.EVENTS_POLL_MS * 2 ** this.failures, 30_000);
    this.schedule(received === CONSUMER_BATCH ? 0 : idle);
  }
}
