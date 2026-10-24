/** One event as stored by the bus; `producer` is the verified caller of Publish. */
export interface BusEvent {
  readonly id: string;
  readonly type: string;
  readonly producer: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly requestId: string | null;
  readonly traceparent: string | null;
  readonly payload: Uint8Array;
}

/** One event leased to one subscriber. */
export interface BusDelivery {
  readonly event: BusEvent;
  readonly publishedAt: Date;
  /** 1 on the first lease, then one more per lease. */
  readonly attempt: number;
  /** Opaque handle that settles this lease, and only this one. */
  readonly receipt: string;
}

export interface DeliveryFailure {
  readonly reason: string;
  readonly message: string;
  /** Stop retrying now instead of after the backoff. */
  readonly deadLetter: boolean;
}

export interface Subscription {
  readonly subscriber: string;
  readonly types: readonly string[];
}

/** `reused`: the id is taken by an event with another type, producer or payload. */
export type PublishResult = 'accepted' | 'duplicate' | 'reused';

/**
 * Where events wait for their subscribers: with EventBrokerAdmin, the seam a queue plugs
 * into (ADR-0005). Every adapter passes the same contract suite
 * (test/event-broker.contract.ts), so the semantics stay those below whatever stores the
 * events: at-least-once, one delivery per subscriber, leases settled by receipt, retries
 * with backoff, then a dead letter.
 */
export abstract class EventBroker {
  /** Creates what the backend needs for the catalog (Postgres: nothing). Called at boot. */
  abstract provision(subscriptions: readonly Subscription[]): Promise<void>;
  /** Idempotent by event id; queues one delivery per subscriber. */
  abstract publish(event: BusEvent, subscribers: readonly string[]): Promise<PublishResult>;
  /** Leases up to `max` ready deliveries of `types` to `subscriber`; returns at once. */
  abstract pull(
    subscriber: string,
    types: readonly string[],
    max: number,
  ): Promise<readonly BusDelivery[]>;
  /** Removes the leased deliveries; unknown, foreign and stale receipts are ignored. */
  abstract ack(subscriber: string, receipts: readonly string[]): Promise<void>;
  /** Retries after the backoff, or dead-letters when asked or out of attempts; stale receipts are ignored. */
  abstract nack(subscriber: string, receipt: string, failure: DeliveryFailure): Promise<void>;
}
