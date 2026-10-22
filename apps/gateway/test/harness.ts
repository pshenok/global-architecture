import { parseConfig } from '@ga/service-kit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.ts';
import { configureGateway, createAdapter } from '../src/bootstrap.ts';
import { ConfigSchema } from '../src/config.ts';

/** Every downstream URL the gateway config requires; tests never connect to them. */
export const TEST_ENV: Readonly<Record<string, string>> = {
  LOG_LEVEL: 'silent',
  TLS_ENABLED: 'false',
  USER_SERVICE_URL: '127.0.0.1:1',
  HOUSE_SERVICE_URL: '127.0.0.1:1',
  BOOKING_SERVICE_URL: '127.0.0.1:1',
};

/** The parts of a light-my-request response the tests use. */
export interface InjectResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly body: string;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted structurally in tests
  json(): any;
}

export interface TestGateway {
  readonly app: NestFastifyApplication;
  inject(options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    payload?: object;
    headers?: Record<string, string>;
  }): Promise<InjectResponse>;
  close(): Promise<void>;
}

/**
 * Boots the real gateway (production adapter and configuration, TLS off) with the given
 * gRPC client tokens replaced by fakes: `createTestGateway(new Map([[USER_SERVICE, fakeUsers]]))`.
 * Clients that are not overridden get an empty object.
 */
export async function createTestGateway(
  clients: ReadonlyMap<symbol, unknown>,
): Promise<TestGateway> {
  Object.assign(process.env, TEST_ENV);
  const config = parseConfig(ConfigSchema);
  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const [token, fake] of clients) builder = builder.overrideProvider(token).useValue(fake);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(config));
  configureGateway(app, config);
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  await fastify.ready();
  return {
    app,
    inject: (options) => fastify.inject(options),
    close: () => app.close(),
  };
}
