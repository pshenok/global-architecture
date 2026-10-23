import { loadProtoPackage } from '@ga/contracts/runtime';
import {
  loadPackageDefinition,
  type ServiceClientConstructor,
  type ServiceError,
} from '@grpc/grpc-js';
import { channelCredentials } from './tls.ts';

export type DownstreamHealth =
  | 'SERVING'
  | 'NOT_SERVING'
  | 'SERVICE_UNKNOWN'
  | 'UNKNOWN'
  | 'UNREACHABLE';

export interface HealthCheckOptions {
  /** Service name to check; `''` (default) is the overall status. */
  readonly service?: string;
  readonly timeoutMs?: number;
  /** CA bundle of the target's certificate (TLS); required for non-loopback targets. */
  readonly caFile?: string | undefined;
}

interface HealthClient {
  check(
    request: { service: string },
    options: { deadline: number },
    callback: (error: ServiceError | null, response?: { status: DownstreamHealth }) => void,
  ): void;
  close(): void;
}

let HealthConstructor: ServiceClientConstructor | undefined;
const clients = new Map<string, HealthClient>();

function clientFor(url: string, caFile: string | undefined): HealthClient {
  const key = `${url}\n${caFile ?? ''}`;
  let client = clients.get(key);
  if (!client) {
    const root = loadPackageDefinition(
      loadProtoPackage(['grpc/health/v1/health.proto']),
    ) as unknown as {
      grpc: { health: { v1: { Health: ServiceClientConstructor } } };
    };
    HealthConstructor ??= root.grpc.health.v1.Health;
    client = new HealthConstructor(url, channelCredentials(url, caFile)) as unknown as HealthClient;
    clients.set(key, client);
  }
  return client;
}

/** Calls grpc.health.v1.Health/Check on a downstream service. */
export function checkGrpcHealth(
  url: string,
  options: HealthCheckOptions = {},
): Promise<DownstreamHealth> {
  const { service = '', timeoutMs = 1_000, caFile } = options;
  return new Promise((resolve) => {
    clientFor(url, caFile).check(
      { service },
      { deadline: Date.now() + timeoutMs },
      (error, response) => {
        resolve(error || !response ? 'UNREACHABLE' : response.status);
      },
    );
  });
}

/** Closes cached health clients (call on shutdown). */
export function closeHealthClients(): void {
  for (const client of clients.values()) client.close();
  clients.clear();
}
