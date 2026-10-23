import {
  decodeStatusDetails,
  installWellKnownTypes,
  loadProtoPackage,
  STATUS_DETAILS_KEY,
  type StatusDetails,
} from '@ga/contracts/runtime';
import {
  type GrpcObject,
  loadPackageDefinition,
  Metadata,
  type ServiceClientConstructor,
  type ServiceError,
} from '@grpc/grpc-js';
import type { Observable } from 'rxjs';
import { channelCredentials } from '../grpc/tls.ts';

/** Turns a generated `XServiceClient` (Observable API) into a Promise API. */
export type PromiseClient<C> = {
  [K in keyof C]: C[K] extends (request: infer Req, metadata?: Metadata) => Observable<infer Res>
    ? (request: Req, metadata?: Metadata) => Promise<Res>
    : never;
};

export type GrpcTestClient<C> = PromiseClient<C> & { close(): void };

/**
 * A plain grpc-js client for tests and scripts, typed with the generated client
 * interface: `createGrpcTestClient<UserServiceClient>('ga.user.v1.UserService', ['ga/user/v1/user.proto'], url)`.
 * Pass `{ caFile }` to call a TLS server (the local stack: `.certs/grpc-ca.pem`).
 */
export function createGrpcTestClient<C>(
  service: string,
  protoFiles: readonly string[],
  url: string,
  options: { readonly caFile?: string } = {},
): GrpcTestClient<C> {
  installWellKnownTypes();
  let node: unknown = loadPackageDefinition(loadProtoPackage(protoFiles));
  for (const part of service.split('.')) node = (node as GrpcObject)[part];
  const Client = node as ServiceClientConstructor;
  if (typeof Client !== 'function')
    throw new Error(`service ${service} not found in ${protoFiles.join(', ')}`);
  const client = new Client(url, channelCredentials(url, options.caFile));
  return new Proxy({} as GrpcTestClient<C>, {
    get(_target, property) {
      if (property === 'close') return () => client.close();
      if (typeof property !== 'string') return undefined;
      const method = (client as unknown as Record<string, unknown>)[property];
      if (typeof method !== 'function') return undefined;
      return (request: unknown, metadata: Metadata = new Metadata()) =>
        new Promise((resolve, reject) => {
          method.call(client, request, metadata, (error: ServiceError | null, response: unknown) =>
            error ? reject(error) : resolve(response),
          );
        });
    },
  });
}

export interface CaughtGrpcError {
  readonly code: number;
  readonly message: string;
  readonly details: StatusDetails | null;
}

/** Awaits a call that must fail and returns its status code, message and decoded rich details. */
export async function grpcError(call: Promise<unknown>): Promise<CaughtGrpcError> {
  try {
    await call;
  } catch (error) {
    const serviceError = error as ServiceError;
    const raw = serviceError.metadata?.get(STATUS_DETAILS_KEY)[0];
    return {
      code: serviceError.code,
      message: serviceError.details,
      details: decodeStatusDetails(typeof raw === 'string' ? Buffer.from(raw) : raw),
    };
  }
  throw new Error('expected the gRPC call to fail, but it succeeded');
}
