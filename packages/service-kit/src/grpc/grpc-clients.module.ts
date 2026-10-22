import { loadProtoPackage } from '@ga/contracts/runtime';
import { DependencyUnavailableError } from '@ga/kernel';
import { InterceptingCall, type Interceptor, status } from '@grpc/grpc-js';
import {
  type DynamicModule,
  Inject,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { type ClientGrpc, ClientProxyFactory, Transport } from '@nestjs/microservices';
import { CONFIG } from '../config/config.ts';
import { currentRequestId, REQUEST_ID_KEY } from '../context/request-context.ts';

export interface GrpcClientDefinition {
  /** DI token under which the typed client (e.g. UserServiceClient) is provided. */
  readonly token: symbol;
  /** Fully-qualified service, e.g. `ga.user.v1.UserService`. */
  readonly service: string;
  /** Proto files that define it, relative to the contracts proto root. */
  readonly protoFiles: readonly string[];
  /** Reads the target `host:port` from the parsed config. */
  readonly url: (config: Record<string, unknown>) => string;
  /** Default deadline per call. Default 3000 ms. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** Retries only UNAVAILABLE (request never processed), with jittered exponential backoff. */
const SERVICE_CONFIG = JSON.stringify({
  methodConfig: [
    {
      name: [{}],
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: '0.1s',
        maxBackoff: '1s',
        backoffMultiplier: 2,
        retryableStatusCodes: ['UNAVAILABLE'],
      },
    },
  ],
});

/** Adds a default deadline and propagates the caller's request id to every outbound call. */
export function outboundContextInterceptor(timeoutMs: number): Interceptor {
  return (callOptions, nextCall) => {
    const options =
      callOptions.deadline === undefined
        ? { ...callOptions, deadline: Date.now() + timeoutMs }
        : callOptions;
    return new InterceptingCall(nextCall(options), {
      start(metadata, listener, next) {
        const requestId = currentRequestId();
        if (requestId && metadata.get(REQUEST_ID_KEY).length === 0)
          metadata.set(REQUEST_ID_KEY, requestId);
        next(metadata, listener);
      },
    });
  };
}

function splitService(fqn: string): { pkg: string; name: string } {
  const index = fqn.lastIndexOf('.');
  return { pkg: fqn.slice(0, index), name: fqn.slice(index + 1) };
}

const CLIENTS = Symbol('GRPC_CLIENT_PROXIES');

class GrpcClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(CLIENTS) private readonly clients: ClientGrpc[]) {}

  onApplicationShutdown(): void {
    for (const client of this.clients) (client as unknown as { close(): void }).close();
  }
}

/**
 * Typed gRPC clients for calling other services.
 *
 *   GrpcClientsModule.register([{ token: USER_SERVICE, service: 'ga.user.v1.UserService',
 *     protoFiles: ['ga/user/v1/user.proto'], url: (c) => c.USER_SERVICE_URL as string }])
 *
 *   constructor(@Inject(USER_SERVICE) private readonly users: UserServiceClient) {}
 *   await firstValueFrom(this.users.getUser({ id }))
 *
 * Every call gets a deadline, the current x-request-id, and retries on UNAVAILABLE.
 * Connections are lazy, so a service starts even when its dependencies are down.
 */
@Module({})
export class GrpcClientsModule {
  static register(definitions: readonly GrpcClientDefinition[]): DynamicModule {
    const proxyTokens = definitions.map((d) => Symbol(`${d.service}:proxy`));
    const providers: Provider[] = definitions.flatMap((definition, index) => {
      const { pkg, name } = splitService(definition.service);
      const proxyToken = proxyTokens[index] as symbol;
      return [
        {
          provide: proxyToken,
          inject: [CONFIG],
          useFactory: (config: Record<string, unknown>) =>
            ClientProxyFactory.create({
              transport: Transport.GRPC,
              options: {
                url: definition.url(config),
                package: pkg,
                packageDefinition: loadProtoPackage(definition.protoFiles),
                channelOptions: {
                  'grpc.service_config': SERVICE_CONFIG,
                  'grpc.keepalive_time_ms': 30_000,
                  interceptors: [
                    outboundContextInterceptor(definition.timeoutMs ?? DEFAULT_TIMEOUT_MS),
                  ],
                },
              },
            }) as unknown as ClientGrpc,
        },
        {
          provide: definition.token,
          inject: [proxyToken],
          useFactory: (client: ClientGrpc) => client.getService(name),
        },
      ];
    });
    return {
      module: GrpcClientsModule,
      providers: [
        ...providers,
        {
          provide: CLIENTS,
          inject: proxyTokens,
          useFactory: (...clients: ClientGrpc[]) => clients,
        },
        GrpcClientsLifecycle,
      ],
      exports: definitions.map((d) => d.token),
    };
  }
}

/** gRPC status code of a client-side error (grpc-js ServiceError), if it is one. */
export function grpcStatusOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' && code >= 0 && code <= 16 ? code : undefined;
}

const TRANSIENT = new Set<number>([
  status.UNAVAILABLE,
  status.DEADLINE_EXCEEDED,
  status.CANCELLED,
  status.RESOURCE_EXHAUSTED,
]);

/**
 * For adapters that call other services: turns transient transport failures into
 * DependencyUnavailableError (-> UNAVAILABLE), and returns any other error as-is
 * so the caller can map the statuses it expects (e.g. NOT_FOUND).
 */
export function toDependencyError(error: unknown, dependency: string): unknown {
  const code = grpcStatusOf(error);
  if (code !== undefined && TRANSIENT.has(code)) {
    const reason = `${dependency.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_UNAVAILABLE`;
    return new DependencyUnavailableError(
      reason,
      `${dependency} is unavailable`,
      {},
      { cause: error },
    );
  }
  return error;
}
