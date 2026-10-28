import { encodeStatusDetails, STATUS_DETAILS_KEY } from '@ga/contracts/runtime';
import { isDomainError, ValidationError } from '@ga/kernel';
import { Metadata, status } from '@grpc/grpc-js';
import { type ArgumentsHost, Catch, Logger, type RpcExceptionFilter } from '@nestjs/common';
import { GrpcException, RpcException } from '@nestjs/microservices';
import { type Observable, throwError } from 'rxjs';
import { pgErrorInfo, translateDbError } from '../database/pg-errors.ts';
import { KIND_TO_GRPC_STATUS } from './error-mapping.ts';

/** gRFC A6 server pushback trailer; a negative value disables client retries for the call. */
export const RETRY_PUSHBACK_KEY = 'grpc-retry-pushback-ms';

interface GrpcErrorPayload {
  code: number;
  message: string;
  metadata?: Metadata;
}

/**
 * The ONE place where errors become gRPC statuses. Always registered by
 * bootstrapGrpcService; there is deliberately no switch to turn it off.
 *
 * - DomainError -> its status code, its message, and a google.rpc.Status trailer
 *   with ErrorInfo (reason, domain, metadata) and BadRequest field violations.
 *   UNAVAILABLE from a DomainError also carries `grpc-retry-pushback-ms: -1`, because
 *   the work was attempted and an automatic retry would only amplify the outage.
 * - A Postgres deadlock or serialization failure -> ABORTED TRANSACTION_CONFLICT, and a
 *   statement timeout -> UNAVAILABLE DATABASE_TIMEOUT, whichever query raised it (a read,
 *   SELECT ... FOR UPDATE, the commit). Repositories still translate their named
 *   constraints themselves; this catches what no repository wrapped.
 * - Nest GrpcException / RpcException({ code }) -> passed through.
 * - Anything else -> INTERNAL with a generic message. The original message and
 *   stack never leave the process (they are logged by the RPC logger).
 */
@Catch()
export class GrpcErrorFilter implements RpcExceptionFilter<unknown> {
  private readonly logger = new Logger(GrpcErrorFilter.name);

  constructor(private readonly domain: string) {}

  catch(error: unknown, _host: ArgumentsHost): Observable<never> {
    return throwError(() => this.toPayload(error));
  }

  toPayload(raised: unknown): GrpcErrorPayload {
    const error = isDomainError(raised) ? raised : translateDbError(raised);
    if (error !== raised) {
      this.logger.warn(
        `database ${pgErrorInfo(raised)?.code}: ${raised instanceof Error ? (raised.stack ?? raised.message) : String(raised)}`,
      );
    }
    if (isDomainError(error)) {
      const code = KIND_TO_GRPC_STATUS[error.kind];
      const metadata = new Metadata();
      metadata.set(
        STATUS_DETAILS_KEY,
        encodeStatusDetails({
          code,
          message: error.message,
          errorInfo: { reason: error.reason, domain: this.domain, metadata: error.metadata },
          ...(error instanceof ValidationError ? { fieldViolations: error.violations } : {}),
        }),
      );
      if (code === status.UNAVAILABLE) {
        // The handler already ran and reports a dependency outage. A negative pushback tells
        // grpc-js clients not to retry (gRFC A6), so retries do not multiply across hops.
        metadata.set(RETRY_PUSHBACK_KEY, '-1');
      }
      return { code, message: error.message, metadata };
    }
    if (error instanceof GrpcException) return error.getError();
    if (error instanceof RpcException) {
      const payload = error.getError();
      if (
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as GrpcErrorPayload).code === 'number'
      ) {
        return payload as GrpcErrorPayload;
      }
    }
    this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return { code: status.INTERNAL, message: 'Internal error' };
  }
}
