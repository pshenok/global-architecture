import type { ServiceActor } from '@ga/kernel';
import { Injectable, Logger } from '@nestjs/common';
import { eventTypeNotSubscribed } from '../domain/event-bus.errors.ts';
import { notSubscribed, topicOf } from '../domain/topics.ts';
import {
  type BusDelivery,
  type BusEvent,
  type DeliveryFailure,
  EventBroker,
} from './ports/event-broker.ts';

/** An event as its producer sends it; the producer is the caller, never a field. */
export type PublishInput = Omit<BusEvent, 'producer'>;

export type PublishOutcome =
  | { readonly outcome: 'ACCEPTED' | 'DUPLICATE' }
  | {
      readonly outcome: 'REJECTED';
      readonly reason: 'EVENT_TYPE_UNKNOWN' | 'EVENT_TYPE_NOT_OWNED' | 'EVENT_ID_REUSED';
    }
  | { readonly outcome: 'UNAVAILABLE'; readonly reason: 'STORE_UNAVAILABLE' };

/** Use cases of the event bus. Only workloads call them; the calling workload comes first. */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);

  constructor(private readonly broker: EventBroker) {}

  /**
   * Stores each event on its own, in order: one refused or failed event never affects
   * the others. A producer may publish only the types the catalog gives it.
   */
  async publish(actor: ServiceActor, events: readonly PublishInput[]): Promise<PublishOutcome[]> {
    const outcomes: PublishOutcome[] = [];
    for (const event of events) outcomes.push(await this.publishOne(actor, event));
    return outcomes;
  }

  private async publishOne(actor: ServiceActor, event: PublishInput): Promise<PublishOutcome> {
    const topic = topicOf(event.type);
    if (!topic) return this.rejected(actor, event, 'EVENT_TYPE_UNKNOWN');
    if (topic.producer !== actor.name) return this.rejected(actor, event, 'EVENT_TYPE_NOT_OWNED');
    try {
      const result = await this.broker.publish(
        { ...event, producer: actor.name },
        topic.subscribers,
      );
      if (result === 'reused') return this.rejected(actor, event, 'EVENT_ID_REUSED');
      return { outcome: result === 'accepted' ? 'ACCEPTED' : 'DUPLICATE' };
    } catch (error) {
      this.logger.error(`cannot store event ${event.id} (${event.type}): ${String(error)}`);
      return { outcome: 'UNAVAILABLE', reason: 'STORE_UNAVAILABLE' };
    }
  }

  private rejected(
    actor: ServiceActor,
    event: PublishInput,
    reason: 'EVENT_TYPE_UNKNOWN' | 'EVENT_TYPE_NOT_OWNED' | 'EVENT_ID_REUSED',
  ): PublishOutcome {
    this.logger.warn(`refused event ${event.id} (${event.type}) from ${actor.name}: ${reason}`);
    return { outcome: 'REJECTED', reason };
  }

  /** Leases deliveries of types the catalog lets the caller receive; refuses any other type. */
  async pull(
    actor: ServiceActor,
    types: readonly string[],
    max: number,
  ): Promise<readonly BusDelivery[]> {
    const unique = [...new Set(types)];
    const refused = notSubscribed(actor.name, unique);
    if (refused.length > 0) throw eventTypeNotSubscribed(actor.name, refused);
    return this.broker.pull(actor.name, unique, max);
  }

  /** Settles the caller's own current leases only. */
  ack(actor: ServiceActor, receipts: readonly string[]): Promise<void> {
    return this.broker.ack(actor.name, receipts);
  }

  async nack(actor: ServiceActor, receipt: string, failure: DeliveryFailure): Promise<void> {
    await this.broker.nack(actor.name, receipt, failure);
    if (failure.deadLetter) {
      this.logger.error(`${actor.name} dead-lettered ${receipt.split('.')[0]}: ${failure.reason}`);
    }
  }
}
