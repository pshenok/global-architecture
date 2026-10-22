import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface ProtobufWrapper {
  fromObject(this: { fromObject(object: unknown): unknown }, value: unknown): unknown;
  toObject(
    this: { toObject(message: unknown, options?: object): Record<string, unknown> },
    message: unknown,
    options?: object,
  ): unknown;
}

let installed = false;

/**
 * Teaches the protobufjs instance used by @grpc/proto-loader to convert
 * google.protobuf.Timestamp <-> Date and google.protobuf.FieldMask <-> string[].
 *
 * Without it a Date in a Timestamp field is silently sent as 1970-01-01.
 * Call it once at the very top of every service and gateway entrypoint, before
 * any RPC. The service kit's bootstrap functions call it for you.
 */
export function installWellKnownTypes(): void {
  if (installed) return;
  const protoLoaderPath = require.resolve('@grpc/proto-loader');
  const protobuf = require(require.resolve('protobufjs', { paths: [protoLoaderPath] })) as {
    wrappers: Record<string, ProtobufWrapper>;
  };

  protobuf.wrappers['.google.protobuf.Timestamp'] = {
    fromObject(value) {
      if (!(value instanceof Date)) return this.fromObject(value);
      const ms = value.getTime();
      if (Number.isNaN(ms)) throw new TypeError('Invalid Date for google.protobuf.Timestamp');
      const seconds = Math.floor(ms / 1000);
      return this.fromObject({ seconds, nanos: (ms - seconds * 1000) * 1e6 });
    },
    toObject(message, options) {
      const { seconds, nanos } = this.toObject(message, { ...options, longs: Number });
      return new Date(Number(seconds) * 1000 + Math.floor(Number(nanos) / 1e6));
    },
  };

  protobuf.wrappers['.google.protobuf.FieldMask'] = {
    fromObject(value) {
      return this.fromObject(Array.isArray(value) ? { paths: value } : value);
    },
    toObject(message, options) {
      return this.toObject(message, options).paths ?? [];
    },
  };

  installed = true;
}
