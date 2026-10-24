import { z } from 'zod';
import { EVENT_TYPE_PATTERN } from '../../domain/topics.ts';

/** Validation of inbound gRPC requests (shape and format). */
const eventType = z.string().regex(EVENT_TYPE_PATTERN, 'must be ga.<domain>.v<N>.<Name>Event');
const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;

/** The request as a whole; each event is checked on its own (PublishedEventSchema). */
export const PublishRequestSchema = z.object({
  events: z.array(z.unknown()).min(1).max(50),
});

/** One event. An invalid one is REJECTED INVALID_EVENT without affecting the others. */
export const PublishedEventSchema = z.object({
  id: z.uuid(),
  type: eventType,
  aggregateId: z.string().min(1).max(128),
  occurTime: z.date(),
  payload: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= MAX_PAYLOAD_BYTES, {
    message: 'must be at most 64 KiB',
  }),
  // Empty means none. A request id that is not safe is dropped, like an inbound header.
  requestId: z.string().transform((value) => (SAFE_REQUEST_ID.test(value) ? value : null)),
  traceparent: z
    .string()
    .refine((value) => value === '' || TRACEPARENT.test(value), 'must be a W3C traceparent')
    .transform((value) => value || null),
});

export const PullRequestSchema = z.object({
  types: z.array(eventType).min(1).max(50),
  maxDeliveries: z.number().int().min(1).max(100),
});

const receipt = z.string().min(1).max(200);

export const AckRequestSchema = z.object({ receipts: z.array(receipt).min(1).max(100) });

export const NackRequestSchema = z.object({
  receipt,
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'must be UPPER_SNAKE'),
  message: z.string().max(1000),
  deadLetter: z.boolean(),
});
