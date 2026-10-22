import { randomUUID } from 'node:crypto';
import type { Metadata } from '@grpc/grpc-js';
import type { ExecutionContext } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';

/** Correlation header (HTTP) and metadata key (gRPC) carried across every hop. */
export const REQUEST_ID_KEY = 'x-request-id';

const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

/** Returns the value when it is a safe request id, otherwise undefined (ids are client-controlled). */
export function sanitizeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value) ? value : undefined;
}

/**
 * Request id of an inbound gRPC call. When the caller sent none, a new one is
 * generated and written back into the call metadata, so the logger and the CLS
 * context (which both call this) agree on the same id.
 */
export function requestIdFromRpc(context: ExecutionContext): string {
  const metadata = context.switchToRpc().getContext<Metadata | undefined>();
  const existing = sanitizeRequestId(metadata?.get?.(REQUEST_ID_KEY)[0]);
  if (existing) return existing;
  const generated = randomUUID();
  metadata?.set?.(REQUEST_ID_KEY, generated);
  return generated;
}

/** Request id of the current call, or undefined outside of a request. */
export function currentRequestId(): string | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    return cls.isActive() ? cls.getId() : undefined;
  } catch {
    return undefined;
  }
}
