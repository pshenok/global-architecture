/** Who may publish an event type, and which workloads receive it. */
export interface Topic {
  readonly producer: string;
  readonly subscribers: readonly string[];
}

/** `ga.<domain>.v<N>.<Aggregate><PastFact>Event`: the payload message, also the topic name. */
export const EVENT_TYPE_PATTERN = /^ga\.[a-z][a-z0-9_]*\.v\d+\.[A-Z][A-Za-z0-9]*Event$/;
const WORKLOAD = /^[a-z][a-z0-9-]*[a-z0-9]$/;

function catalog(topics: Readonly<Record<string, Topic>>): Readonly<Record<string, Topic>> {
  const entries = Object.entries(topics).map(
    ([type, { producer, subscribers }]): [string, Topic] => {
      if (!EVENT_TYPE_PATTERN.test(type)) {
        throw new TypeError(`topic ${type}: not ga.<domain>.v<N>.<Aggregate><PastFact>Event`);
      }
      for (const workload of [producer, ...subscribers]) {
        if (!WORKLOAD.test(workload)) {
          throw new TypeError(`topic ${type}: "${workload}" is not a workload`);
        }
      }
      if (subscribers.includes(producer)) {
        throw new TypeError(`topic ${type}: ${producer} would receive its own events`);
      }
      if (new Set(subscribers).size !== subscribers.length) {
        throw new TypeError(`topic ${type}: a subscriber is listed twice`);
      }
      return [type, Object.freeze({ producer, subscribers: Object.freeze([...subscribers]) })];
    },
  );
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * The event catalog (ADR-0005, CODEOWNERS): the one place that says who publishes an
 * event type and who receives it. Publish refuses a type that is missing here or that
 * belongs to another workload; Pull refuses a type that does not list the caller.
 *
 * A change here goes together with the @Access lists in event-bus.grpc-controller.ts and
 * their entries in security/public-endpoints.json (a test compares all three). A new
 * subscriber only receives events published after it is listed; `pnpm events:replay`
 * backfills retained ones from the last MAX_RETENTION_DAYS (21).
 */
export const TOPICS = catalog({
  'ga.house.v1.HouseDeletedEvent': { producer: 'house-service', subscribers: ['booking-service'] },
  'ga.user.v1.UserDeletedEvent': {
    producer: 'user-service',
    subscribers: ['house-service', 'booking-service'],
  },
});

export function topicOf(type: string): Topic | undefined {
  return Object.hasOwn(TOPICS, type) ? TOPICS[type] : undefined;
}

/** Types of `types` that the catalog does not let `subscriber` receive. */
export function notSubscribed(subscriber: string, types: readonly string[]): string[] {
  return types.filter((type) => !topicOf(type)?.subscribers.includes(subscriber));
}

/** Every (subscriber, types) pair of the catalog, for backends that provision queues. */
export function subscriptions(): { readonly subscriber: string; readonly types: string[] }[] {
  const bySubscriber = new Map<string, string[]>();
  for (const [type, { subscribers }] of Object.entries(TOPICS)) {
    for (const subscriber of subscribers) {
      bySubscriber.set(subscriber, [...(bySubscriber.get(subscriber) ?? []), type]);
    }
  }
  return [...bySubscriber].map(([subscriber, types]) => ({ subscriber, types }));
}
