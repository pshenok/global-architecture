import { PermissionDeniedError, PreconditionFailedError } from '@ga/kernel';

export const eventTypeNotSubscribed = (subscriber: string, types: readonly string[]) =>
  new PermissionDeniedError(
    'EVENT_TYPE_NOT_SUBSCRIBED',
    `the event catalog does not list ${subscriber} as a subscriber of ${types.join(', ')}`,
    { types: types.join(',') },
  );

/** An operator command needs a pair the catalog lists (redrive with a type, replay). */
export const subscriptionNotListed = (subscriber: string, type: string) =>
  new PreconditionFailedError(
    'SUBSCRIPTION_NOT_LISTED',
    `the catalog does not list ${subscriber} for ${type}`,
    { subscriber, type },
  );

/** `drop` only deletes the deliveries of a pair the catalog no longer lists. */
export const subscriptionStillListed = (subscriber: string, type: string) =>
  new PreconditionFailedError(
    'SUBSCRIPTION_STILL_LISTED',
    `the catalog still lists ${subscriber} for ${type}`,
    { subscriber, type },
  );
