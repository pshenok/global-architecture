import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PackageDefinition } from '@grpc/proto-loader';
import { DESCRIPTORS_PATH } from './loader.ts';

const require = createRequire(import.meta.url);

/**
 * A package definition for @grpc/reflection built from the buf image
 * (descriptors.binpb), not from proto-loader. proto-loader synthesizes invalid
 * FileDescriptorProtos (fake file names, no dependencies), which makes buf curl
 * and grpcurl fail with "failed to find service".
 */
export function reflectionPackageDefinition(): PackageDefinition {
  const descriptor = require(
    require.resolve('protobufjs/ext/descriptor', {
      paths: [require.resolve('@grpc/proto-loader')],
    }),
  ) as {
    FileDescriptorSet: { decode(buffer: Buffer): { file: unknown[] } };
    FileDescriptorProto: { encode(message: unknown): { finish(): Uint8Array } };
  };
  const set = descriptor.FileDescriptorSet.decode(readFileSync(DESCRIPTORS_PATH));
  const fileDescriptorProtos = set.file.map((file) =>
    Buffer.from(descriptor.FileDescriptorProto.encode(file).finish()),
  );
  return {
    __descriptors: { format: 'reflection-only', type: {}, fileDescriptorProtos },
  } as unknown as PackageDefinition;
}
