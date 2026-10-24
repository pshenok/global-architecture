/** Leases a delivery may take before it is dead-lettered, unless configured otherwise. */
export const DEFAULT_MAX_ATTEMPTS = 10;

/**
 * Wait before a failed delivery is leased again: 1 s, 2 s, 4 s ... capped at 5 min. With
 * the default 10 attempts, a delivery nacked every time waits about 8.5 minutes in all
 * (1 + 2 + ... + 256 s), plus the time each of its leases is held.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 300_000);
}
