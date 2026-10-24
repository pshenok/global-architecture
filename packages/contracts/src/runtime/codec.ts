import { join } from 'node:path';
import { PROTO_ROOT } from './loader.ts';
import { wellKnownProtobuf } from './wkt.ts';

/**
 * Binary protobuf encoding of one message type, outside gRPC (e.g. event payloads).
 * Untyped on purpose: whoever decodes validates the object (a Zod schema) to get a type.
 */
export interface MessageCodec {
  /** Fully-qualified message name, e.g. `ga.house.v1.HouseDeletedEvent`. */
  readonly type: string;
  encode(message: object): Uint8Array;
  /** Throws when the bytes are not a valid encoding. */
  decode(bytes: Uint8Array): Readonly<Record<string, unknown>>;
}

/** The conversions of GRPC_LOADER_OPTIONS, so payloads look exactly like RPC messages. */
const TO_OBJECT = Object.freeze({ longs: Number, enums: String, defaults: true, oneofs: false });

const codecs = new Map<string, MessageCodec>();

/**
 * Codec of a message defined in a contract file (relative to PROTO_ROOT), e.g.
 * `messageCodec('ga/house/v1/house_events.proto', 'ga.house.v1.HouseDeletedEvent')`.
 * Keys are camelCase like the generated interfaces, unset scalars decode to their
 * defaults and unset messages to null, Timestamps to Date. Throws at once when the file
 * or the message does not exist. Cached per message.
 */
export function messageCodec(protoFile: string, fullName: string): MessageCodec {
  const key = `${protoFile}#${fullName}`;
  const cached = codecs.get(key);
  if (cached) return cached;
  const protobuf = wellKnownProtobuf();
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) =>
    target.startsWith('google/protobuf/') ? target : join(PROTO_ROOT, target);
  root.loadSync(protoFile, { keepCase: false });
  const type = root.lookupType(fullName);
  const codec: MessageCodec = Object.freeze({
    type: fullName,
    encode: (message: object) => type.encode(type.fromObject(message)).finish(),
    decode: (bytes: Uint8Array) => type.toObject(type.decode(bytes), TO_OBJECT),
  });
  codecs.set(key, codec);
  return codec;
}
