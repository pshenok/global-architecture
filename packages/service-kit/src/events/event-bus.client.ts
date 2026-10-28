import type {
  EventBusServiceClient,
  Event as EventMessage,
} from '@ga/contracts/ga/event_bus/v1/event_bus';
import { PublishOutcome } from '@ga/contracts/ga/event_bus/v1/event_bus';
import { Inject, Injectable } from '@nestjs/common';
import { firstValueFrom, type Observable } from 'rxjs';
import { toDependencyError } from '../grpc/grpc-clients.module.ts';

/** An event on the wire between a service and the bus. */
export interface WireEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly payload: Uint8Array;
  readonly requestId: string | null;
  readonly traceparent: string | null;
}

export interface PublishStatus {
  readonly eventId: string;
  readonly outcome: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'UNAVAILABLE';
  /** Why it was refused or not stored; empty otherwise. */
  readonly reason: string;
}

/** One event leased to this service. */
export interface WireDelivery {
  readonly event: WireEvent;
  /** The workload that published it, as the bus verified it. */
  readonly producer: string;
  readonly publishedAt: Date;
  readonly attempt: number;
  readonly receipt: string;
}

export interface WireFailure {
  readonly reason: string;
  readonly message: string;
  readonly deadLetter: boolean;
}

/**
 * The kit's side of ga.event_bus.v1.EventBusService. Only the outbox relay and the
 * event consumer use it; tests replace it with FakeEventBus. Not a seam for services:
 * no service talks to the bus, let alone to a queue, directly.
 */
export abstract class EventBusClient {
  abstract publish(events: readonly WireEvent[]): Promise<readonly PublishStatus[]>;
  abstract pull(types: readonly string[], max: number): Promise<readonly WireDelivery[]>;
  abstract ack(receipts: readonly string[]): Promise<void>;
  abstract nack(receipt: string, failure: WireFailure): Promise<void>;
}

export const EVENT_BUS_GRPC = Symbol('EVENT_BUS_GRPC');

const OUTCOME: Readonly<Record<string, PublishStatus['outcome']>> = {
  [PublishOutcome.PUBLISH_OUTCOME_ACCEPTED]: 'ACCEPTED',
  [PublishOutcome.PUBLISH_OUTCOME_DUPLICATE]: 'DUPLICATE',
  [PublishOutcome.PUBLISH_OUTCOME_REJECTED]: 'REJECTED',
};

function toMessage(event: WireEvent): EventMessage {
  return {
    id: event.id,
    type: event.type,
    aggregateId: event.aggregateId,
    occurTime: event.occurredAt,
    payload: Buffer.from(event.payload),
    requestId: event.requestId ?? '',
    traceparent: event.traceparent ?? '',
  };
}

/** EventBusClient over gRPC (GrpcClientsModule: TLS, caller assertion, deadline, retries). */
@Injectable()
export class GrpcEventBusClient extends EventBusClient {
  constructor(@Inject(EVENT_BUS_GRPC) private readonly bus: EventBusServiceClient) {
    super();
  }

  async publish(events: readonly WireEvent[]): Promise<readonly PublishStatus[]> {
    const { results } = await this.call(this.bus.publish({ events: events.map(toMessage) }));
    return results.map((result) => ({
      eventId: result.eventId,
      outcome: OUTCOME[result.outcome] ?? 'UNAVAILABLE',
      reason: result.reason,
    }));
  }

  async pull(types: readonly string[], max: number): Promise<readonly WireDelivery[]> {
    const { deliveries } = await this.call(
      this.bus.pull({ types: [...types], maxDeliveries: max }),
    );
    return deliveries.flatMap(({ event, producer, publishTime, attempt, receipt }) =>
      event?.occurTime && publishTime
        ? [
            {
              event: {
                id: event.id,
                type: event.type,
                aggregateId: event.aggregateId,
                occurredAt: event.occurTime,
                payload: new Uint8Array(event.payload),
                requestId: event.requestId || null,
                traceparent: event.traceparent || null,
              },
              producer,
              publishedAt: publishTime,
              attempt,
              receipt,
            },
          ]
        : [],
    );
  }

  async ack(receipts: readonly string[]): Promise<void> {
    await this.call(this.bus.ack({ receipts: [...receipts] }));
  }

  async nack(receipt: string, failure: WireFailure): Promise<void> {
    await this.call(this.bus.nack({ receipt, ...failure }));
  }

  private async call<R>(response: Observable<R>): Promise<R> {
    try {
      return await firstValueFrom(response);
    } catch (error) {
      throw toDependencyError(error, 'event-bus-service');
    }
  }
}
