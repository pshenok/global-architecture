import type { INestMicroservice, Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { bootstrapGrpcService } from '../grpc/bootstrap.ts';
import type { ServiceDefinition } from '../platform/service-definition.ts';
import { freePort } from './free-port.ts';

export interface TestService {
  readonly app: INestMicroservice;
  /** `127.0.0.1:<port>` the service listens on. */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Boots a real gRPC service in-process on a free port, exactly like main.ts does
 * (same filter, health, reflection, logging), with optional provider overrides.
 */
export async function startTestService(options: {
  readonly module: Type<unknown>;
  readonly service: ServiceDefinition;
  /** Extra environment (e.g. DATABASE_URL from createTestDatabase). */
  readonly env?: Readonly<Record<string, string>>;
  /** e.g. `(b) => b.overrideProvider(UserDirectory).useValue(fake)` */
  readonly override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}): Promise<TestService> {
  const port = await freePort();
  const url = `127.0.0.1:${port}`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    GRPC_HOST: '127.0.0.1',
    GRPC_PORT: String(port),
    ...options.env,
  });
  let builder = Test.createTestingModule({ imports: [options.module] });
  if (options.override) builder = options.override(builder);
  const moduleRef = await builder.compile();
  const app = await bootstrapGrpcService(moduleRef, options.service, { url, shutdownHooks: false });
  return { app, url, close: () => app.close() };
}
