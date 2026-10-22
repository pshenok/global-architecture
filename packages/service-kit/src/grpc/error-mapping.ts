import type { DomainErrorKind } from '@ga/kernel';
import { status } from '@grpc/grpc-js';

/** Domain error kind -> gRPC status code. */
export const KIND_TO_GRPC_STATUS: Readonly<Record<DomainErrorKind, status>> = Object.freeze({
  INVALID_ARGUMENT: status.INVALID_ARGUMENT,
  NOT_FOUND: status.NOT_FOUND,
  ALREADY_EXISTS: status.ALREADY_EXISTS,
  FAILED_PRECONDITION: status.FAILED_PRECONDITION,
  ABORTED: status.ABORTED,
  PERMISSION_DENIED: status.PERMISSION_DENIED,
  UNAUTHENTICATED: status.UNAUTHENTICATED,
  RESOURCE_EXHAUSTED: status.RESOURCE_EXHAUSTED,
  UNAVAILABLE: status.UNAVAILABLE,
});

/** gRPC status code -> HTTP status, per google/rpc/code.proto. */
export const GRPC_TO_HTTP_STATUS: Readonly<Record<number, number>> = Object.freeze({
  [status.OK]: 200,
  [status.CANCELLED]: 499,
  [status.UNKNOWN]: 500,
  [status.INVALID_ARGUMENT]: 400,
  [status.DEADLINE_EXCEEDED]: 504,
  [status.NOT_FOUND]: 404,
  [status.ALREADY_EXISTS]: 409,
  [status.PERMISSION_DENIED]: 403,
  [status.RESOURCE_EXHAUSTED]: 429,
  [status.FAILED_PRECONDITION]: 400,
  [status.ABORTED]: 409,
  [status.OUT_OF_RANGE]: 400,
  [status.UNIMPLEMENTED]: 501,
  [status.INTERNAL]: 500,
  [status.UNAVAILABLE]: 503,
  [status.DATA_LOSS]: 500,
  [status.UNAUTHENTICATED]: 401,
});

/** Canonical name of a gRPC status code, e.g. 5 -> "NOT_FOUND". */
export function grpcStatusName(code: number): string {
  return status[code] ?? 'UNKNOWN';
}
