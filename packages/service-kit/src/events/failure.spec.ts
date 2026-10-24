import {
  ConcurrencyError,
  ConflictError,
  DependencyUnavailableError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
} from '@ga/kernel';
import { describe, expect, it } from 'vitest';
import { RemoteCallInTransactionError } from '../grpc/grpc-clients.module.ts';
import { classifyFailure } from './failure.ts';

const pgError = (code: string) =>
  Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' });

describe('classifyFailure', () => {
  it.each([
    [new ConcurrencyError('ROW_CHANGED', 'x'), 'retry', 'ROW_CHANGED'],
    [
      new DependencyUnavailableError('USER_SERVICE_UNAVAILABLE', 'x'),
      'retry',
      'USER_SERVICE_UNAVAILABLE',
    ],
    [new RateLimitedError('SLOW_DOWN', 'x'), 'retry', 'SLOW_DOWN'],
    [pgError('40001'), 'retry', 'TRANSACTION_CONFLICT'],
    [pgError('40P01'), 'retry', 'TRANSACTION_CONFLICT'],
    [pgError('57014'), 'retry', 'DATABASE_TIMEOUT'],
    [new TypeError('boom'), 'retry', 'HANDLER_FAILED'],
    ['a string', 'retry', 'HANDLER_FAILED'],
    [new ValidationError('bad'), 'dead', 'VALIDATION_FAILED'],
    [new NotFoundError('HOUSE_NOT_FOUND', 'x'), 'dead', 'HOUSE_NOT_FOUND'],
    [new ConflictError('TAKEN', 'x'), 'dead', 'TAKEN'],
    [new PreconditionFailedError('GONE', 'x'), 'dead', 'GONE'],
    [new PermissionDeniedError('NO', 'x'), 'dead', 'NO'],
    [new UnauthenticatedError('SERVICE_REQUIRED', 'x'), 'dead', 'SERVICE_REQUIRED'],
    [new RemoteCallInTransactionError('user-service'), 'dead', 'REMOTE_CALL_IN_TRANSACTION'],
    [
      new Error('wrapped', { cause: new RemoteCallInTransactionError('user-service') }),
      'dead',
      'REMOTE_CALL_IN_TRANSACTION',
    ],
  ])('%s -> %s %s', (error, action, reason) => {
    expect(classifyFailure(error)).toMatchObject({ action, reason });
  });

  it('keeps messages short', () => {
    expect(classifyFailure(new Error('x'.repeat(5000))).message).toHaveLength(1000);
  });
});
