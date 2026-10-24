import { PermissionDeniedError } from '@ga/kernel';

export const eventTypeNotSubscribed = (subscriber: string, types: readonly string[]) =>
  new PermissionDeniedError(
    'EVENT_TYPE_NOT_SUBSCRIBED',
    `the event catalog does not list ${subscriber} as a subscriber of ${types.join(', ')}`,
    { types: types.join(',') },
  );
