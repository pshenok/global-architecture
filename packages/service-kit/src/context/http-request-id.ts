import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { REQUEST_ID_KEY, sanitizeRequestId } from './request-context.ts';

/**
 * Fastify `genReqId`: reuse a safe inbound `x-request-id`, otherwise generate one.
 * The same id then flows into logs, CLS and outbound gRPC metadata.
 */
export function requestIdFromHttp(request: { headers: IncomingHttpHeaders }): string {
  const header = request.headers[REQUEST_ID_KEY];
  return sanitizeRequestId(Array.isArray(header) ? header[0] : header) ?? randomUUID();
}
