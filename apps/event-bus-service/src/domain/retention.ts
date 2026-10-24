/**
 * Days an event stays safe to deliver again: the cap of EVENT_BUS_RETENTION_DAYS and the
 * window of `events:replay`. Consumers remember processed event ids for 30 days (the
 * kit's EventConsumer), which must exceed this plus the ~14 minute retry window, or a
 * replay runs handlers twice. Raise it only together with that.
 */
export const MAX_RETENTION_DAYS = 21;
