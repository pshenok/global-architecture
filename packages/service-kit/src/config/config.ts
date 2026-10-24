import { type DynamicModule, Inject, Module } from '@nestjs/common';
import { z } from 'zod';
import { workloadIdentityConfigSchema } from '../auth/config.ts';
import { grpcTlsConfigSchema } from '../grpc/tls.ts';

/** DI token of the parsed, typed configuration object. Inject with {@link InjectConfig}. */
export const CONFIG = Symbol('CONFIG');

/** `constructor(@InjectConfig() private readonly config: Config)` */
export const InjectConfig = (): ParameterDecorator => Inject(CONFIG);

const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/** Variables every gRPC service needs. Extend it in the service's config.ts. */
export const grpcServiceConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: logLevel.default('info'),
  LOG_PRETTY: z.stringbool().default(false),
  /** Bind address. Loopback by default (safe); containers set 0.0.0.0 explicitly. */
  GRPC_HOST: z.string().min(1).default('127.0.0.1'),
  GRPC_PORT: z.coerce.number().int().min(1).max(65_535),
  /**
   * Optional plaintext port serving only grpc.health.v1, for Kubernetes native gRPC
   * probes (kubelet cannot speak TLS). Status only, never another RPC.
   */
  GRPC_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  /** Max inbound/outbound gRPC message size. Keep small: big messages are a memory DoS vector. */
  GRPC_MAX_MESSAGE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(4 * 1024 * 1024),
  /** Pause between reporting NOT_SERVING and closing the server, so load balancers can drain. */
  SHUTDOWN_DELAY_MS: z.coerce.number().int().min(0).default(0),
  /** Serve gRPC server reflection. Default: on, except when NODE_ENV=production. */
  GRPC_REFLECTION: z.stringbool().optional(),
  ...grpcTlsConfigSchema.shape,
  ...workloadIdentityConfigSchema.shape,
});

/** Variables of services that own a Postgres database. */
export const databaseConfigSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /**
   * Below the shortest caller deadline (2 s between services, 5 s from the gateway), so a
   * slow statement or lock wait ends as DATABASE_TIMEOUT before the caller's deadline does.
   */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),
});

/** `host:port` of another gRPC service, e.g. `USER_SERVICE_URL: grpcTarget()`. */
export const grpcTarget = () => z.string().regex(/^[\w.-]+:\d{1,5}$/, 'must be host:port');

export type GrpcServiceConfig = z.output<typeof grpcServiceConfigSchema>;
export type DatabaseConfig = z.output<typeof databaseConfigSchema>;

/**
 * Parses and validates environment variables. Throws one readable error listing
 * every problem, so a misconfigured service fails at boot instead of at first use.
 */
export function parseConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid configuration:\n${problems}`);
}

@Module({})
export class ConfigModule {
  /** Parses lazily (at DI time), so tests can set process.env before compiling the module. */
  static forRoot(schema: z.ZodType): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: CONFIG, useFactory: () => parseConfig(schema) }],
      exports: [CONFIG],
    };
  }
}
