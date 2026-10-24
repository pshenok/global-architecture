import { randomUUID } from 'node:crypto';
import { messageCodec } from '@ga/contracts/runtime';
import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import {
  EventBusClient,
  type PublishStatus,
  type WireDelivery,
  type WireEvent,
  type WireFailure,
} from '../events/event-bus.client.ts';
import { type DeliveryOutcome, EventConsumer } from '../events/event-consumer.ts';
import type { EventType } from '../events/event-type.ts';
import { OutboxRelay } from '../events/outbox-relay.ts';

export type { DeliveryOutcome };
export { EventBusClient, type PublishStatus, type WireDelivery, type WireEvent, type WireFailure };

/**
 * In-memory stand-in for event-bus-service, bound with
 * `override: (b) => b.overrideProvider(EventBusClient).useValue(bus)`.
 * Records what was published, acked and nacked; `respond` scripts publish outcomes,
 * `failNext` makes the next call throw, `hold` keeps Publish in flight until released.
 */
export class FakeEventBus extends EventBusClient {
  readonly published: WireEvent[] = [];
  readonly acked: string[] = [];
  readonly nacked: { receipt: string; failure: WireFailure }[] = [];
  readonly pulls: { types: readonly string[]; max: number }[] = [];
  /** Deliveries the next pulls hand out, in order. */
  readonly queue: WireDelivery[] = [];
  private outcome: (event: WireEvent) => Omit<PublishStatus, 'eventId'> = () => ({
    outcome: 'ACCEPTED',
    reason: '',
  });
  private failure: Error | undefined;
  private held: Promise<void> | undefined;

  /** How the bus answers each published event (default: ACCEPTED). */
  respond(outcome: (event: WireEvent) => Omit<PublishStatus, 'eventId'>): this {
    this.outcome = outcome;
    return this;
  }

  /** The next call (any method) throws `error`. */
  failNext(error: Error): this {
    this.failure = error;
    return this;
  }

  /** Publish waits until the returned function is called. */
  hold(): () => void {
    let release!: () => void;
    this.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  async publish(events: readonly WireEvent[]): Promise<readonly PublishStatus[]> {
    this.throwIfFailing();
    if (this.held) await this.held;
    this.published.push(...events);
    return events.map((event) => ({ eventId: event.id, ...this.outcome(event) }));
  }

  async pull(types: readonly string[], max: number): Promise<readonly WireDelivery[]> {
    this.throwIfFailing();
    this.pulls.push({ types: [...types], max });
    return this.queue.splice(0, max);
  }

  async ack(receipts: readonly string[]): Promise<void> {
    this.throwIfFailing();
    this.acked.push(...receipts);
  }

  async nack(receipt: string, failure: WireFailure): Promise<void> {
    this.throwIfFailing();
    this.nacked.push({ receipt, failure });
  }

  private throwIfFailing(): void {
    const failure = this.failure;
    this.failure = undefined;
    if (failure) throw failure;
  }
}

/** One outbox round of a test service (EVENTS_AUTOSTART is off in tests); returns rows claimed. */
export function flushOutbox(app: INestApplicationContext): Promise<number> {
  return app.get(OutboxRelay).flush();
}

/** A delivery as event-bus-service would hand it out. */
export function testDelivery<T extends object>(
  event: EventType<T>,
  payload: T,
  options: {
    readonly id?: string;
    readonly producer?: string;
    readonly attempt?: number;
    readonly requestId?: string | null;
    readonly aggregateId?: string;
    readonly rawPayload?: Uint8Array;
  } = {},
): WireDelivery {
  const id = options.id ?? randomUUID();
  return {
    event: {
      id,
      type: event.type,
      aggregateId: options.aggregateId ?? id,
      occurredAt: new Date(),
      payload: options.rawPayload ?? messageCodec(event.protoFile, event.type).encode(payload),
      requestId: options.requestId ?? null,
      traceparent: null,
    },
    producer: options.producer ?? event.producer,
    publishedAt: new Date(),
    attempt: options.attempt ?? 1,
    receipt: `${id}.${randomUUID()}`,
  };
}

/**
 * Runs the service's handler of `event` on one delivery, exactly as the consumer loop
 * does (fresh context as the service itself, dedupe and handler in one transaction),
 * and returns what would be acked or nacked.
 */
export function deliverEvent<T extends object>(
  app: INestApplicationContext,
  event: EventType<T>,
  payload: T,
  options: Parameters<typeof testDelivery>[2] = {},
): Promise<DeliveryOutcome> {
  return app.get(EventConsumer).process(testDelivery(event, payload, options));
}

/** Outbox rows of one event type, oldest first, with decoded payloads. */
export async function recordedEvents<T extends object>(
  pool: pg.Pool,
  event: EventType<T>,
): Promise<{ id: string; aggregateId: string; payload: T; requestId: string | null }[]> {
  const codec = messageCodec(event.protoFile, event.type);
  const { rows } = await pool.query<{
    id: string;
    aggregate_id: string;
    payload: Buffer;
    request_id: string | null;
  }>(
    'select id, aggregate_id, payload, request_id from outbox where type = $1 order by occurred_at, id',
    [event.type],
  );
  return rows.map((row) => ({
    id: row.id,
    aggregateId: row.aggregate_id,
    payload: codec.decode(row.payload) as T,
    requestId: row.request_id,
  }));
}
