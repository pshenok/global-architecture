import { describe, expect, it } from 'vitest';
import { loadProtoPackage } from './loader.ts';
import { reflectionPackageDefinition } from './reflection.ts';
import { decodeStatusDetails, encodeStatusDetails } from './status-details.ts';
import { installWellKnownTypes } from './wkt.ts';

interface MethodDefinition {
  requestSerialize(value: unknown): Buffer;
  requestDeserialize(buffer: Buffer): Record<string, unknown>;
  responseSerialize(value: unknown): Buffer;
  responseDeserialize(buffer: Buffer): Record<string, unknown>;
}

function method(service: string, rpc: string, files: string[]): MethodDefinition {
  const pkg = loadProtoPackage(files) as unknown as Record<
    string,
    Record<string, MethodDefinition>
  >;
  const definition = pkg[service]?.[rpc];
  if (!definition) throw new Error(`${service}/${rpc} not found`);
  return definition;
}

describe('proto runtime', () => {
  installWellKnownTypes();
  const getBooking = method('ga.booking.v1.BookingService', 'GetBooking', [
    'ga/booking/v1/booking.proto',
  ]);
  const updateUser = method('ga.user.v1.UserService', 'UpdateUser', ['ga/user/v1/user.proto']);

  it('round-trips Date through google.protobuf.Timestamp with ms precision', () => {
    const created = new Date('2026-10-22T10:11:12.345Z');
    const before1970 = new Date('1969-12-31T23:59:59.500Z');
    const wire = getBooking.responseSerialize({
      booking: { id: 'b1', createTime: created, cancelTime: before1970 },
    });
    const decoded = getBooking.responseDeserialize(wire) as { booking: Record<string, unknown> };
    expect(decoded.booking.createTime).toEqual(created);
    expect(decoded.booking.cancelTime).toEqual(before1970);
    expect(decoded.booking.updateTime).toBeNull();
  });

  it('decodes enums as strings, defaults unset enums to UNSPECIFIED and int64 to number', () => {
    const wire = getBooking.responseSerialize({
      booking: { id: 'b1', totalPrice: { currencyCode: 'USD', amountMinor: 12_550 } },
    });
    const { booking } = getBooking.responseDeserialize(wire) as {
      booking: Record<string, unknown>;
    };
    expect(booking.status).toBe('BOOKING_STATUS_UNSPECIFIED');
    expect(booking.totalPrice).toEqual({ currencyCode: 'USD', amountMinor: 12_550 });
    expect(booking.guests).toBe(0);
  });

  it('keeps proto3 optional presence without virtual oneof keys', () => {
    const decoded = updateUser.requestDeserialize(
      updateUser.requestSerialize({ id: 'u1', fullName: '' }),
    );
    expect(decoded).toEqual({ id: 'u1', fullName: '' });
    expect('email' in decoded).toBe(false);
  });

  it('rejects an invalid Date instead of sending the epoch', () => {
    expect(() =>
      getBooking.responseSerialize({ booking: { id: 'b1', createTime: new Date('nope') } }),
    ).toThrow(/Invalid Date/);
  });
});

describe('status details', () => {
  it('round-trips ErrorInfo and BadRequest field violations', () => {
    const buffer = encodeStatusDetails({
      code: 3,
      message: 'invalid input',
      errorInfo: { reason: 'VALIDATION_FAILED', domain: 'user-service', metadata: { a: 'b' } },
      fieldViolations: [{ field: 'email', description: 'must be an email' }],
    });
    expect(decodeStatusDetails(buffer)).toEqual({
      code: 3,
      message: 'invalid input',
      errorInfo: { reason: 'VALIDATION_FAILED', domain: 'user-service', metadata: { a: 'b' } },
      fieldViolations: [{ field: 'email', description: 'must be an email' }],
    });
  });

  it('returns null for missing or garbage input', () => {
    expect(decodeStatusDetails(undefined)).toBeNull();
    expect(decodeStatusDetails(Buffer.from([0xff, 0xff, 0xff]))).toBeNull();
  });
});

describe('reflection descriptors', () => {
  it('exposes real file descriptors for every contract', () => {
    const definition = reflectionPackageDefinition() as unknown as {
      __descriptors: { fileDescriptorProtos: Buffer[] };
    };
    const files = definition.__descriptors.fileDescriptorProtos.map((b) => b.toString('latin1'));
    for (const name of [
      'ga/user/v1/user.proto',
      'ga/house/v1/house.proto',
      'ga/booking/v1/booking.proto',
      'grpc/health/v1/health.proto',
    ]) {
      expect(files.some((f) => f.includes(name))).toBe(true);
    }
  });
});
