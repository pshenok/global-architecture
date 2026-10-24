import type { EventType } from './event-type.ts';

/** Handler method -> the event type it handles. Only @OnEvent writes it. */
const handlers = new WeakMap<object, EventType<object>>();

/**
 * Marks a provider method as the handler of one event type (ADR-0005). The kit's
 * EventConsumer pulls that type, decodes the payload and calls the method inside a
 * transaction, once per event id: the handler's writes and the dedupe row commit
 * together. Put handlers in `src/transport/events/`, call one use case with
 * `currentService()`, and make no remote calls (they are refused inside the
 * transaction). A service has at most one handler per type.
 *
 *   @OnEvent(HOUSE_DELETED)
 *   async houseDeleted(event: HouseDeletedEvent): Promise<void> {
 *     await this.bookings.cancelOpenStaysOfHouse(currentService(), event.houseId);
 *   }
 *
 * Handlers must be idempotent in effect and must not depend on order: the same event
 * may arrive again after a crash, and events of one aggregate can arrive in any order.
 */
export function OnEvent<T extends object>(event: EventType<T>) {
  return (
    _target: object,
    _key: string | symbol,
    descriptor: TypedPropertyDescriptor<(payload: T) => Promise<void>>,
  ): void => {
    if (descriptor.value) handlers.set(descriptor.value, event);
  };
}

/** The event type a method handles, if it is an @OnEvent handler. */
export function handledEventOf(method: unknown): EventType<object> | undefined {
  return typeof method === 'function' ? handlers.get(method) : undefined;
}
