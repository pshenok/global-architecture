import {
  Injectable,
  type MiddlewareConsumer,
  Module,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestGateway } from './harness.ts';

// What createTestGateway must refuse: ways around the controllers, so around AuthGuard.
// Code in this file is neither a package nor bootstrap.ts / http/openapi.ts.

const server = (host: HttpAdapterHost) => host.httpAdapter.getInstance<FastifyInstance>();

@Injectable()
class StrayRoute implements OnModuleInit {
  constructor(private readonly host: HttpAdapterHost) {}
  onModuleInit() {
    server(this.host).get('/stray', async () => 'no AuthGuard here');
  }
}

@Injectable()
class StrayHook implements OnModuleInit {
  constructor(private readonly host: HttpAdapterHost) {}
  onModuleInit() {
    server(this.host).addHook('onRequest', async () => undefined);
  }
}

@Injectable()
class ScheduledHook implements OnModuleInit {
  constructor(private readonly host: HttpAdapterHost) {}
  onModuleInit() {
    const instance = server(this.host);
    queueMicrotask(instance.addHook.bind(instance, 'onRequest', async () => undefined));
  }
}

@Injectable()
class LateRoute implements OnModuleInit {
  constructor(private readonly host: HttpAdapterHost) {}
  onModuleInit() {
    const instance = server(this.host);
    instance.after(() => {
      instance.get('/late', async () => 'no AuthGuard here');
    });
  }
}

@Injectable()
class FastifyMiddleware implements OnApplicationBootstrap {
  constructor(private readonly host: HttpAdapterHost) {}
  onApplicationBootstrap() {
    const instance = server(this.host) as unknown as { use(fn: () => void): void };
    instance.use(() => undefined);
  }
}

@Module({})
class FieldMiddlewareModule {
  readonly configure = (consumer: MiddlewareConsumer) => {
    consumer.apply((_: unknown, __: unknown, next: () => void) => next()).forRoutes('{*path}');
  };
}

const moduleWith = (provider: new (...args: never[]) => unknown) => {
  @Module({ providers: [provider] })
  class ProbeModule {}
  return ProbeModule;
};

describe('createTestGateway refuses requests served outside the controllers', () => {
  it.each([
    ['a route on the HTTP adapter', moduleWith(StrayRoute), 'route GET /stray'],
    ['a Fastify hook', moduleWith(StrayHook), 'addHook(onRequest) (from unknown)'],
    [
      'a hook scheduled from a microtask',
      moduleWith(ScheduledHook),
      'addHook(onRequest) (from unknown)',
    ],
    ['a route added at Fastify boot', moduleWith(LateRoute), 'route GET /late'],
    ['middleware on the Fastify instance', moduleWith(FastifyMiddleware), 'use('],
    [
      'Nest middleware from a class field',
      FieldMiddlewareModule,
      'Nest middleware (consumer.apply) (from unknown)',
    ],
  ])('%s', async (_name, module, report) => {
    await expect(createTestGateway(new Map(), { imports: [module] })).rejects.toThrow(report);
  });

  it('boots the real gateway, CORS preflight included', async () => {
    const gateway = await createTestGateway(new Map(), {
      env: { CORS_ORIGINS: 'https://app.example' },
    });
    await gateway.close();
    process.env.CORS_ORIGINS = '';
  });
});
