import { fileURLToPath } from 'node:url';
import * as protoLoader from '@grpc/proto-loader';

/** Absolute path of the buf module root (`packages/contracts/proto`), valid from src/ and dist/. */
export const PROTO_ROOT = fileURLToPath(new URL('../../proto', import.meta.url));

/** buf-built FileDescriptorSet of every contract, used for gRPC server reflection. */
export const DESCRIPTORS_PATH = fileURLToPath(new URL('../../descriptors.binpb', import.meta.url));

/**
 * The ONE set of proto-loader options for servers and clients. They must match the
 * ts-proto options in buf.gen.yaml, otherwise runtime objects drift from the types:
 * - keepCase false      -> camelCase keys like the generated interfaces
 * - longs Number        -> forceLong=number (int64 above 2^53 would lose precision; ids are strings)
 * - enums String        -> stringEnums=true
 * - defaults true       -> scalars are always present; unset message fields are null
 * - oneofs false        -> no virtual `_field` keys that break object spreads
 */
export const GRPC_LOADER_OPTIONS: protoLoader.Options = Object.freeze({
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: false,
  includeDirs: [PROTO_ROOT],
});

/**
 * Loads proto files relative to PROTO_ROOT, e.g. `loadProtoPackage(['ga/user/v1/user.proto'])`.
 * Pass the result to Nest as `packageDefinition` (never `protoPath`, which lets Nest
 * pick an arbitrary proto-loader copy).
 */
export function loadProtoPackage(files: readonly string[]): protoLoader.PackageDefinition {
  return protoLoader.loadSync([...files], GRPC_LOADER_OPTIONS);
}
