import { join } from 'node:path';
import protobuf from 'protobufjs';
import { PROTO_ROOT } from './loader.ts';

/**
 * Rich gRPC error details (AIP-193): a google.rpc.Status carried in the
 * `grpc-status-details-bin` trailer, with ErrorInfo and BadRequest details.
 * buf curl, grpcurl and Connect clients decode it natively.
 */
export const STATUS_DETAILS_KEY = 'grpc-status-details-bin';

export interface ErrorInfoDetail {
  readonly reason: string;
  readonly domain: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface FieldViolationDetail {
  readonly field: string;
  readonly description: string;
}

export interface StatusDetails {
  readonly code: number;
  readonly message: string;
  readonly errorInfo?: ErrorInfoDetail;
  readonly fieldViolations?: readonly FieldViolationDetail[];
}

const TYPE_PREFIX = 'type.googleapis.com/';

let types:
  | { Status: protobuf.Type; ErrorInfo: protobuf.Type; BadRequest: protobuf.Type }
  | undefined;

function loadTypes() {
  if (types) return types;
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) =>
    target.startsWith('google/protobuf/') ? target : join(PROTO_ROOT, target);
  root.loadSync(['google/rpc/status.proto', 'google/rpc/error_details.proto'], { keepCase: true });
  types = {
    Status: root.lookupType('google.rpc.Status'),
    ErrorInfo: root.lookupType('google.rpc.ErrorInfo'),
    BadRequest: root.lookupType('google.rpc.BadRequest'),
  };
  return types;
}

export function encodeStatusDetails(details: StatusDetails): Buffer {
  const { Status, ErrorInfo, BadRequest } = loadTypes();
  const any: { type_url: string; value: Uint8Array }[] = [];
  if (details.errorInfo) {
    any.push({
      type_url: `${TYPE_PREFIX}google.rpc.ErrorInfo`,
      value: ErrorInfo.encode(ErrorInfo.fromObject({ ...details.errorInfo })).finish(),
    });
  }
  if (details.fieldViolations && details.fieldViolations.length > 0) {
    any.push({
      type_url: `${TYPE_PREFIX}google.rpc.BadRequest`,
      value: BadRequest.encode(
        BadRequest.fromObject({ field_violations: details.fieldViolations.map((v) => ({ ...v })) }),
      ).finish(),
    });
  }
  const status = Status.fromObject({ code: details.code, message: details.message, details: any });
  return Buffer.from(Status.encode(status).finish());
}

/** Decodes the trailer value; returns null when it is missing or malformed. */
export function decodeStatusDetails(buffer: Buffer | Uint8Array | undefined): StatusDetails | null {
  if (!buffer || buffer.length === 0) return null;
  const { Status, ErrorInfo, BadRequest } = loadTypes();
  try {
    const status = Status.toObject(Status.decode(buffer), { defaults: true }) as {
      code: number;
      message: string;
      details: { type_url: string; value: Uint8Array }[];
    };
    let errorInfo: ErrorInfoDetail | undefined;
    let fieldViolations: FieldViolationDetail[] | undefined;
    for (const detail of status.details) {
      if (detail.type_url === `${TYPE_PREFIX}google.rpc.ErrorInfo`) {
        const info = ErrorInfo.toObject(ErrorInfo.decode(detail.value), { defaults: true }) as {
          reason: string;
          domain: string;
          metadata: Record<string, string>;
        };
        errorInfo = { reason: info.reason, domain: info.domain, metadata: info.metadata };
      } else if (detail.type_url === `${TYPE_PREFIX}google.rpc.BadRequest`) {
        const bad = BadRequest.toObject(BadRequest.decode(detail.value), { defaults: true }) as {
          field_violations: { field: string; description: string }[];
        };
        fieldViolations = bad.field_violations.map((v) => ({
          field: v.field,
          description: v.description,
        }));
      }
    }
    return {
      code: status.code,
      message: status.message,
      ...(errorInfo ? { errorInfo } : {}),
      ...(fieldViolations ? { fieldViolations } : {}),
    };
  } catch {
    return null;
  }
}
