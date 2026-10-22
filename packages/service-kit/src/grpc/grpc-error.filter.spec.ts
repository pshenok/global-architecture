import { decodeStatusDetails, STATUS_DETAILS_KEY } from '@ga/contracts/runtime';
import {
  ConflictError,
  DependencyUnavailableError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '@ga/kernel';
import { status } from '@grpc/grpc-js';
import { GrpcNotFoundException, RpcException } from '@nestjs/microservices';
import { describe, expect, it } from 'vitest';
import { GrpcErrorFilter } from './grpc-error.filter.ts';

const filter = new GrpcErrorFilter('user-service');

function detailsOf(payload: ReturnType<GrpcErrorFilter['toPayload']>) {
  const raw = payload.metadata?.get(STATUS_DETAILS_KEY)[0];
  return decodeStatusDetails(typeof raw === 'string' ? Buffer.from(raw) : raw);
}

describe('GrpcErrorFilter', () => {
  it.each([
    [new NotFoundError('USER_NOT_FOUND', 'user 1 not found'), status.NOT_FOUND],
    [new ConflictError('USER_EMAIL_TAKEN', 'taken'), status.ALREADY_EXISTS],
    [
      new PreconditionFailedError('BOOKING_CANCELLED', 'already cancelled'),
      status.FAILED_PRECONDITION,
    ],
    [new DependencyUnavailableError('USER_SERVICE_UNAVAILABLE', 'down'), status.UNAVAILABLE],
  ])('maps %s to its gRPC status with ErrorInfo details', (error, code) => {
    const payload = filter.toPayload(error);
    expect(payload.code).toBe(code);
    expect(payload.message).toBe(error.message);
    expect(detailsOf(payload)?.errorInfo).toEqual({
      reason: error.reason,
      domain: 'user-service',
      metadata: {},
    });
  });

  it('adds BadRequest field violations for ValidationError', () => {
    const payload = filter.toPayload(
      new ValidationError('invalid email', [
        { field: 'email', description: 'Invalid email address' },
      ]),
    );
    expect(payload.code).toBe(status.INVALID_ARGUMENT);
    expect(detailsOf(payload)?.fieldViolations).toEqual([
      { field: 'email', description: 'Invalid email address' },
    ]);
  });

  it('never leaks the message of an unexpected error', () => {
    const payload = filter.toPayload(new Error('db password=hunter2 leaked?'));
    expect(payload).toEqual({ code: status.INTERNAL, message: 'Internal error' });
  });

  it('passes through Nest gRPC exceptions and coded RpcExceptions', () => {
    expect(filter.toPayload(new GrpcNotFoundException('gone'))).toEqual({
      code: status.NOT_FOUND,
      message: 'gone',
    });
    expect(
      filter.toPayload(new RpcException({ code: status.PERMISSION_DENIED, message: 'no' })),
    ).toEqual({
      code: status.PERMISSION_DENIED,
      message: 'no',
    });
    expect(filter.toPayload(new RpcException('string form'))).toEqual({
      code: status.INTERNAL,
      message: 'Internal error',
    });
  });
});
