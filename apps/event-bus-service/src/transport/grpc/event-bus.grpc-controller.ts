import type {
  AckRequest,
  AckResponse,
  EventBusServiceController,
  NackRequest,
  NackResponse,
  PublishRequest,
  PublishResponse,
  PullRequest,
  PullResponse,
} from '@ga/contracts/ga/event_bus/v1/event_bus';
import { EventBusServiceControllerMethods } from '@ga/contracts/ga/event_bus/v1/event_bus';
import { Access, currentService, parseRequest } from '@ga/service-kit';
import { Controller } from '@nestjs/common';
import { EventBusService, type PublishInput } from '../../application/event-bus.service.ts';
import { invalidEventResult, toDeliveryMessage, toPublishResult } from './event-bus.mappers.ts';
import {
  AckRequestSchema,
  NackRequestSchema,
  PublishedEventSchema,
  PublishRequestSchema,
  PullRequestSchema,
} from './event-bus.requests.ts';

/**
 * gRPC adapter of the event bus. Only workloads call it, as themselves: the lists below
 * must match the producers and subscribers in domain/topics.ts (a test compares them),
 * and each is listed in security/public-endpoints.json.
 */
@Controller()
@EventBusServiceControllerMethods()
export class EventBusGrpcController implements EventBusServiceController {
  constructor(private readonly bus: EventBusService) {}

  @Access.service(['house-service', 'user-service'])
  async publish(request: PublishRequest): Promise<PublishResponse> {
    const { events } = parseRequest(PublishRequestSchema, request);
    const checked = events.map((event) => PublishedEventSchema.safeParse(event));
    const valid: PublishInput[] = checked.flatMap((check) =>
      check.success
        ? [
            {
              id: check.data.id,
              type: check.data.type,
              aggregateId: check.data.aggregateId,
              occurredAt: check.data.occurTime,
              payload: check.data.payload,
              requestId: check.data.requestId,
              traceparent: check.data.traceparent,
            },
          ]
        : [],
    );
    const outcomes = await this.bus.publish(currentService(), valid);
    let next = 0;
    return {
      results: checked.map((check, index) => {
        if (!check.success) return invalidEventResult(request.events[index]?.id);
        const outcome = outcomes[next++];
        return outcome
          ? toPublishResult(check.data.id, outcome)
          : invalidEventResult(check.data.id);
      }),
    };
  }

  @Access.service(['booking-service', 'house-service'])
  async pull(request: PullRequest): Promise<PullResponse> {
    const { types, maxDeliveries } = parseRequest(PullRequestSchema, request);
    const deliveries = await this.bus.pull(currentService(), types, maxDeliveries);
    return { deliveries: deliveries.map(toDeliveryMessage) };
  }

  @Access.service(['booking-service', 'house-service'])
  async ack(request: AckRequest): Promise<AckResponse> {
    const { receipts } = parseRequest(AckRequestSchema, request);
    await this.bus.ack(currentService(), receipts);
    return {};
  }

  @Access.service(['booking-service', 'house-service'])
  async nack(request: NackRequest): Promise<NackResponse> {
    const { receipt, ...failure } = parseRequest(NackRequestSchema, request);
    await this.bus.nack(currentService(), receipt, failure);
    return {};
  }
}
