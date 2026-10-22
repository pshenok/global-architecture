import { loadProtoPackage } from '@ga/contracts/runtime';
import {
  credentials,
  loadPackageDefinition,
  type ServiceClientConstructor,
  type ServiceError,
} from '@grpc/grpc-js';

export type DownstreamHealth =
  | 'SERVING'
  | 'NOT_SERVING'
  | 'SERVICE_UNKNOWN'
  | 'UNKNOWN'
  | 'UNREACHABLE';

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

function clientFor(url: string): HealthClient {
  let client = clients.get(url);
  if (!client) {
    const root = loadPackageDefinition(
      loadProtoPackage(['grpc/health/v1/health.proto']),
    ) as unknown as {
      grpc: { health: { v1: { Health: ServiceClientConstructor } } };
    };
    HealthConstructor ??= root.grpc.health.v1.Health;
    client = new HealthConstructor(url, credentials.createInsecure()) as unknown as HealthClient;
    clients.set(url, client);
  }
  return client;
}

/** Calls grpc.health.v1.Health/Check on a downstream service (`''` = overall status). */
export function checkGrpcHealth(
  url: string,
  service = '',
  timeoutMs = 1_000,
): Promise<DownstreamHealth> {
  return new Promise((resolve) => {
    clientFor(url).check({ service }, { deadline: Date.now() + timeoutMs }, (error, response) => {
      resolve(error || !response ? 'UNREACHABLE' : response.status);
    });
  });
}

/** Closes cached health clients (call on shutdown). */
export function closeHealthClients(): void {
  for (const client of clients.values()) client.close();
  clients.clear();
}
