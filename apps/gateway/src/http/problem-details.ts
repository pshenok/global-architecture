import { STATUS_CODES } from 'node:http';
import { decodeStatusDetails, STATUS_DETAILS_KEY } from '@ga/contracts/runtime';
import { isDomainError, ValidationError } from '@ga/kernel';
import {
  GRPC_TO_HTTP_STATUS,
  grpcStatusName,
  KIND_TO_GRPC_STATUS,
  PLATFORM_AUTH_FAULTS,
} from '@ga/service-kit';
import { status as grpcStatus, Metadata } from '@grpc/grpc-js';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/** RFC 9457 problem details, plus machine-readable extensions shared by every error. */
export const ProblemDetails = z
  .object({
    type: z.string().describe('Always "about:blank"; use `code` to branch on errors.'),
    title: z.string().describe('HTTP reason phrase.'),
    status: z.number().int(),
    detail: z.string().optional().describe('Human-readable explanation (omitted for 5xx).'),
    instance: z.string().describe('Request path.'),
    code: z
      .string()
      .describe('Stable machine-readable reason, e.g. USER_EMAIL_TAKEN or NOT_FOUND.'),
    domain: z.string().optional().describe('Service that produced the error.'),
    metadata: z.record(z.string(), z.string()).optional(),
    errors: z
      .array(z.object({ field: z.string(), description: z.string() }))
      .optional()
      .describe('Invalid fields (validation errors).'),
    requestId: z.string().describe('Correlation id, also in the x-request-id header.'),
  })
  .meta({ id: 'ProblemDetails' });

export type ProblemDetails = z.output<typeof ProblemDetails>;

interface ServiceErrorLike {
  code: number;
  details: string;
  metadata: Metadata;
}

function isServiceError(error: unknown): error is ServiceErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as ServiceErrorLike).code === 'number' &&
    (error as ServiceErrorLike).metadata instanceof Metadata
  );
}

function base(status: number, instance: string, requestId: string) {
  return {
    type: 'about:blank',
    title: STATUS_CODES[status] ?? 'Error',
    status,
    instance,
    requestId,
  };
}

/**
 * A service rejected how the gateway called it (the gateway authenticated the user and
 * forwards a principal, so a downstream UNAUTHENTICATED is the platform's bug, not the
 * client's): never a 401, which would send clients into a sign-in loop.
 */
function isPlatformAuthFault(code: number, reason: string | undefined): boolean {
  return (
    code === grpcStatus.UNAUTHENTICATED ||
    (code === grpcStatus.PERMISSION_DENIED &&
      reason !== undefined &&
      PLATFORM_AUTH_FAULTS.has(reason))
  );
}

/**
 * Maps any error to problem details:
 * - gRPC errors from downstream services: status via google/rpc/code.proto, plus
 *   ErrorInfo reason/domain/metadata and field violations from the status trailer
 *   (authentication faults between gateway and service become 500)
 * - DomainError raised in the gateway (request validation)
 * - Nest HttpException (404 route, 429 throttling, ...)
 * - anything else: 500 without internals
 */
export function toProblemDetails(
  error: unknown,
  instance: string,
  requestId: string,
): ProblemDetails {
  if (isServiceError(error)) {
    const raw = error.metadata.get(STATUS_DETAILS_KEY)[0];
    const details = decodeStatusDetails(typeof raw === 'string' ? Buffer.from(raw) : raw);
    const info = details?.errorInfo;
    if (isPlatformAuthFault(error.code, info?.reason)) {
      return { ...base(500, instance, requestId), code: 'INTERNAL' };
    }
    const status = GRPC_TO_HTTP_STATUS[error.code] ?? 500;
    return {
      ...base(status, instance, requestId),
      ...(status < 500 && error.details ? { detail: error.details } : {}),
      code: info?.reason ?? grpcStatusName(error.code),
      ...(info?.domain ? { domain: info.domain } : {}),
      ...(info && Object.keys(info.metadata).length > 0 ? { metadata: { ...info.metadata } } : {}),
      ...(details?.fieldViolations?.length ? { errors: [...details.fieldViolations] } : {}),
    };
  }
  if (isDomainError(error)) {
    const status = GRPC_TO_HTTP_STATUS[KIND_TO_GRPC_STATUS[error.kind]] ?? 500;
    return {
      ...base(status, instance, requestId),
      detail: error.message,
      code: error.reason,
      ...(error instanceof ValidationError && error.violations.length > 0
        ? { errors: [...error.violations] }
        : {}),
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      ...base(status, instance, requestId),
      ...(status < 500 ? { detail: error.message } : {}),
      code: (STATUS_CODES[status] ?? 'ERROR').toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
    };
  }
  return { ...base(500, instance, requestId), code: 'INTERNAL' };
}

/** The gateway's only exception filter: every error leaves as application/problem+json. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = toProblemDetails(
      error,
      request.url.split('?')[0] ?? request.url,
      String(request.id),
    );
    if (problem.status >= 500 && (!isServiceError(error) || problem.code === 'INTERNAL')) {
      this.logger.error(
        isServiceError(error)
          ? `downstream ${grpcStatusName(error.code)}: ${error.details}`
          : error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      );
    }
    if (problem.status === 401) {
      // RFC 6750: say which scheme is expected, and whether the token sent was the problem.
      const presented = request.headers.authorization !== undefined;
      void reply.header(
        'www-authenticate',
        `Bearer realm="ga"${presented ? ', error="invalid_token"' : ''}`,
      );
    }
    void reply
      .status(problem.status)
      .header('content-type', 'application/problem+json')
      .send(problem);
  }
}
