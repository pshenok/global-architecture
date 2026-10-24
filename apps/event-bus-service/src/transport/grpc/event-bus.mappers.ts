import {
  type Delivery,
  PublishOutcome,
  type PublishResult,
} from '@ga/contracts/ga/event_bus/v1/event_bus';
import type { PublishOutcome as Outcome } from '../../application/event-bus.service.ts';
import type { BusDelivery } from '../../application/ports/event-broker.ts';

const OUTCOME: Readonly<Record<Outcome['outcome'], PublishOutcome>> = {
  ACCEPTED: PublishOutcome.PUBLISH_OUTCOME_ACCEPTED,
  DUPLICATE: PublishOutcome.PUBLISH_OUTCOME_DUPLICATE,
  REJECTED: PublishOutcome.PUBLISH_OUTCOME_REJECTED,
  UNAVAILABLE: PublishOutcome.PUBLISH_OUTCOME_UNAVAILABLE,
};

/** Use case -> wire. */
export function toPublishResult(eventId: string, result: Outcome): PublishResult {
  return {
    eventId,
    outcome: OUTCOME[result.outcome],
    reason: 'reason' in result ? result.reason : '',
  };
}

/** An event that failed validation: refused alone, the rest of the batch goes on. */
export function invalidEventResult(eventId: unknown): PublishResult {
  return {
    eventId: typeof eventId === 'string' ? eventId.slice(0, 64) : '',
    outcome: PublishOutcome.PUBLISH_OUTCOME_REJECTED,
    reason: 'INVALID_EVENT',
  };
}

export function toDeliveryMessage(delivery: BusDelivery): Delivery {
  const { event } = delivery;
  return {
    event: {
      id: event.id,
      type: event.type,
      aggregateId: event.aggregateId,
      occurTime: event.occurredAt,
      payload: Buffer.from(event.payload),
      requestId: event.requestId ?? '',
      traceparent: event.traceparent ?? '',
    },
    producer: event.producer,
    publishTime: delivery.publishedAt,
    attempt: delivery.attempt,
    receipt: delivery.receipt,
  };
}
