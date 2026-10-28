import { messageCodec } from '@ga/contracts/runtime';

/** `ga.<domain>.v<N>.<Aggregate><PastFact>Event`, e.g. `ga.house.v1.HouseDeletedEvent`. */
const EVENT_TYPE = /^ga\.([a-z][a-z0-9_]*)\.v(\d+)\.[A-Z][A-Za-z0-9]*Event$/;
const WORKLOAD = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * An event type as one service sees it: the payload message (`type`, also the topic),
 * the only workload that may publish it, and its contract file. `T` is the generated
 * payload interface; it exists for type checking only.
 */
export interface EventType<T extends object> {
  readonly type: string;
  readonly producer: string;
  /** `ga/<domain>/v<N>/<domain>_events.proto`, relative to the contracts proto root. */
  readonly protoFile: string;
  /** Never set: carries the payload type. */
  readonly payload?: T;
}

/**
 * Declares an event type, in the producer (to publish it with Outbox.add) and in each
 * consumer (to handle it with @OnEvent). Each side declares its own copy:
 *
 *   export const HOUSE_DELETED = defineEvent<HouseDeletedEvent>(
 *     'ga.house.v1.HouseDeletedEvent', { producer: 'house-service' });
 *
 * Throws when the name breaks the convention, or the payload message does not exist.
 */
export function defineEvent<T extends object>(
  type: string,
  options: { readonly producer: string },
): EventType<T> {
  const match = EVENT_TYPE.exec(type);
  if (!match) {
    throw new TypeError(`event type "${type}" is not ga.<domain>.v<N>.<Aggregate><PastFact>Event`);
  }
  if (!WORKLOAD.test(options.producer)) {
    throw new TypeError(`event ${type}: producer "${options.producer}" is not a workload name`);
  }
  const [, domain, version] = match;
  const protoFile = `ga/${domain}/v${version}/${domain}_events.proto`;
  messageCodec(protoFile, type);
  return Object.freeze({ type, producer: options.producer, protoFile });
}
