/** Deliveries of one event type that one subscriber has not settled yet. */
export interface QueueStats {
  readonly subscriber: string;
  readonly type: string;
  /** Waiting or leased. */
  readonly pending: number;
  /** Dead letters, kept until redriven or dropped. */
  readonly dead: number;
  /** When the event of the oldest pending delivery was published; null when none is pending. */
  readonly oldestPendingPublishedAt: Date | null;
}

/** A replay queues events published at or after both times. */
export interface ReplayWindow {
  /** What the operator asked for. */
  readonly since: Date;
  /** The safety cap: events from `since` on but published before this are skipped. */
  readonly notBefore: Date;
}

export interface ReplayResult {
  readonly queued: number;
  /** Events skipped by `notBefore` that the subscriber holds no delivery for. */
  readonly skipped: number;
}

/**
 * Operator and retention work on the store behind EventBroker (ADR-0005), for
 * `pnpm events:*` and retention: the other half of the seam a queue plugs into. Storage
 * only: the catalog rules live in EventBusAdmin. Every adapter passes the same contract
 * suite (test/event-broker-admin.contract.ts).
 */
export abstract class EventBrokerAdmin {
  /** Every (subscriber, type) with pending or dead deliveries, by subscriber, then type. */
  abstract queues(): Promise<readonly QueueStats[]>;
  /** Dead letters of `subscriber` of `types` back to pending with fresh attempts; returns how many. */
  abstract redrive(subscriber: string, types: readonly string[]): Promise<number>;
  /**
   * Queues a delivery to `subscriber` for every stored event of `type` in `window` that it
   * holds no delivery for (pending or dead).
   */
  abstract replay(subscriber: string, type: string, window: ReplayWindow): Promise<ReplayResult>;
  /** Deletes the deliveries of `subscriber` of `type`, pending or dead; returns how many. */
  abstract drop(subscriber: string, type: string): Promise<number>;
  /**
   * Deletes events published more than `olderThanDays` ago that no delivery holds any more
   * (a dead letter keeps its event); returns how many. Safe on every replica at once.
   */
  abstract purgeDelivered(olderThanDays: number): Promise<number>;
}
