import { messageCodec } from '@ga/contracts/runtime';
import { Clock, IdGenerator } from '@ga/kernel';
import { Inject, Injectable } from '@nestjs/common';
import { context, propagation } from '@opentelemetry/api';
import { currentRequestId } from '../context/request-context.ts';
import { DbContext } from '../database/db-context.ts';
import { SERVICE_DEFINITION, type ServiceDefinition } from '../platform/service-definition.ts';
import type { EventType } from './event-type.ts';
import { outbox } from './tables.ts';

/** Largest encoded payload: the bus and the outbox table refuse anything bigger. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** The W3C traceparent of the active span, when tracing is on. */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/**
 * Records events in the producer's own database, in the transaction of the change that
 * caused them (ADR-0005): an event exists if and only if its change committed. The
 * kit's OutboxRelay publishes them to event-bus-service afterwards, at least once.
 *
 * Call it from an infrastructure adapter of a domain-named port, inside UnitOfWork.run:
 *
 *   deleted(house: House) {
 *     return this.outbox.add(HOUSE_DELETED, house.id, { houseId: house.id, ownerId: house.ownerId });
 *   }
 */
@Injectable()
export class Outbox {
  constructor(
    private readonly db: DbContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(SERVICE_DEFINITION) private readonly service: ServiceDefinition,
  ) {}

  /**
   * Throws, rolling the change back, outside a transaction, for an event this service
   * does not own, for an aggregate id that is not 1..128 chars, or a payload over 64 KiB.
   */
  async add<T extends object>(event: EventType<T>, aggregateId: string, payload: T): Promise<void> {
    if (!this.db.inTransaction()) {
      throw new Error(
        `Outbox.add(${event.type}) outside UnitOfWork.run(): an event must commit with its change`,
      );
    }
    if (event.producer !== this.service.name) {
      throw new Error(
        `${this.service.name} cannot publish ${event.type}: ${event.producer} owns it`,
      );
    }
    if (aggregateId.length < 1 || aggregateId.length > 128) {
      throw new Error(`${event.type}: the aggregate id must be 1..128 characters`);
    }
    const bytes = messageCodec(event.protoFile, event.type).encode(payload);
    if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
      throw new Error(`${event.type}: payload of ${bytes.byteLength} bytes is over 64 KiB`);
    }
    await this.db.tx.insert(outbox).values({
      id: this.ids.newId(),
      type: event.type,
      aggregateId,
      occurredAt: this.clock.now(),
      payload: Buffer.from(bytes),
      requestId: currentRequestId() ?? null,
      traceparent: currentTraceparent(),
    });
  }
}
