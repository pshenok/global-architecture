import { readFileSync } from 'node:fs';
import { type ChannelCredentials, credentials, ServerCredentials } from '@grpc/grpc-js';
import { z } from 'zod';

/**
 * TLS between workloads. Plaintext gRPC is allowed only on loopback addresses; a
 * service that binds anything else (0.0.0.0 in containers) must present a
 * certificate, and a client that calls a non-loopback target must verify one.
 * Tokens travel in gRPC metadata, so plaintext off the machine would leak them.
 */
export const grpcTlsConfigSchema = z.object({
  /** PEM certificate chain this service presents. Set together with GRPC_TLS_KEY_FILE. */
  GRPC_TLS_CERT_FILE: z.string().min(1).optional(),
  GRPC_TLS_KEY_FILE: z.string().min(1).optional(),
  /** PEM CA bundle that signed the other services' certificates; enables TLS on outbound calls. */
  GRPC_TLS_CA_FILE: z.string().min(1).optional(),
});

export type GrpcTlsConfig = z.output<typeof grpcTlsConfigSchema>;

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i;
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-f:]+\]?)$/i;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host);
}

/** Host of a `host:port` target. */
export function targetHost(target: string): string {
  const colon = target.lastIndexOf(':');
  return colon === -1 ? target : target.slice(0, colon);
}

function readPem(file: string, variable: string): Buffer {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new Error(
      `${variable}=${file} cannot be read (run \`pnpm certs\` locally): ${String(error)}`,
    );
  }
}

/** Server credentials for a bind address; refuses plaintext anywhere but loopback. */
export function serverCredentials(config: GrpcTlsConfig, bindHost: string): ServerCredentials {
  const { GRPC_TLS_CERT_FILE: certFile, GRPC_TLS_KEY_FILE: keyFile } = config;
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error('GRPC_TLS_CERT_FILE and GRPC_TLS_KEY_FILE must be set together');
  }
  if (certFile && keyFile) {
    return ServerCredentials.createSsl(
      null,
      [
        {
          cert_chain: readPem(certFile, 'GRPC_TLS_CERT_FILE'),
          private_key: readPem(keyFile, 'GRPC_TLS_KEY_FILE'),
        },
      ],
      false,
    );
  }
  if (!isLoopbackHost(bindHost)) {
    throw new Error(
      `refusing to serve plaintext gRPC on ${bindHost}: set GRPC_TLS_CERT_FILE and GRPC_TLS_KEY_FILE (only loopback addresses may run without TLS)`,
    );
  }
  return ServerCredentials.createInsecure();
}

/**
 * Channel credentials for a target; refuses plaintext to anything but loopback.
 * With TLS the target must be a host name (`localhost:50051`, `user-service:50051`):
 * grpc-js sends the host as the TLS server name, and Node refuses IP addresses there.
 */
export function channelCredentials(target: string, caFile: string | undefined): ChannelCredentials {
  if (caFile) {
    if (IP_LITERAL.test(targetHost(target))) {
      throw new Error(
        `cannot verify TLS for ${target}: use the host name the certificate was issued for (e.g. localhost) instead of an IP address`,
      );
    }
    return credentials.createSsl(readPem(caFile, 'GRPC_TLS_CA_FILE'));
  }
  if (!isLoopbackHost(targetHost(target))) {
    throw new Error(
      `refusing to call ${target} over plaintext gRPC: set GRPC_TLS_CA_FILE (only loopback targets may run without TLS)`,
    );
  }
  return credentials.createInsecure();
}
