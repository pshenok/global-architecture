/**
 * Days an event stays safe to deliver again: the cap of EVENT_BUS_RETENTION_DAYS and the
 * window of `events:replay`. Consumers remember processed event ids for the kit's
 * PROCESSED_EVENTS_KEPT_DAYS (30), which must exceed this plus the longest retry window,
 * or a replay runs handlers twice (src/config.spec.ts checks the margin).
 */
export const MAX_RETENTION_DAYS = 21;
