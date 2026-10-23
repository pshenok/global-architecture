import { isDomainError } from '@ga/kernel';
import type { ExecutionContext } from '@nestjs/common';
import type { Params } from 'nestjs-pino';
import { principalFrom } from '../auth/principal-context.ts';
import type { GrpcServiceConfig } from '../config/config.ts';
import { requestIdFromRpc } from '../context/request-context.ts';

/** Fields that must never reach logs, wherever they appear. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*["x-ga-principal"]',
  '*["x-ga-caller"]',
];

/** Adds who called (workload, and user when there is one) to the per-RPC log line. */
function withCaller(context: ExecutionContext, value: object): object {
  const call = principalFrom(context);
  if (!call) return value;
  return {
    ...value,
    caller: call.caller,
    ...(call.actor.kind === 'user' ? { userId: call.actor.userId } : {}),
  };
}

const CLIENT_ERROR_KINDS = new Set([
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'FAILED_PRECONDITION',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
]);

/** Expected business errors are warnings, not errors: they are the caller's problem. */
export function rpcLogLevel(_context: ExecutionContext, error?: Error): 'info' | 'warn' | 'error' {
  if (!error) return 'info';
  return isDomainError(error) && CLIENT_ERROR_KINDS.has(error.kind) ? 'warn' : 'error';
}

/** nestjs-pino params for a gRPC service: JSON to stdout, one line per RPC, request id on every line. */
export function grpcLoggerParams(serviceName: string, config: GrpcServiceConfig): Params {
  return {
    pinoHttp: {
      level: config.LOG_LEVEL,
      base: { service: serviceName },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      ...(config.LOG_PRETTY
        ? {
            transport: {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
          }
        : {}),
    },
    microservice: {
      genReqId: requestIdFromRpc,
      customAttributeKeys: { reqId: 'requestId' },
      customLogLevel: rpcLogLevel,
      // Runs when the RPC ends, after the auth guard (customProps would run before it).
      customSuccessObject: (context, _result, value) => withCaller(context, value),
      customErrorObject: (context, _error, value) => withCaller(context, value),
      quietRpcLogger: true,
    },
  };
}
