import type { Role } from '@ga/kernel';
import { parseConfig } from '@ga/service-kit';
import {
  createTestWorkloadKeys,
  expectListedOpenEndpoints,
  type TestWorkloadKeys,
} from '@ga/service-kit/testing';
import type { Type } from '@nestjs/common';
import { MiddlewareBuilder } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.ts';
import { AuthRoutes } from '../src/auth/auth-routes.ts';
import {
  type Identity,
  IdentityResolver,
  type ResolvedUser,
} from '../src/auth/identity-resolver.ts';
import { configureGateway, createAdapter } from '../src/bootstrap.ts';
import { ConfigSchema } from '../src/config.ts';
import {
  createTestIssuer,
  TEST_AUDIENCE,
  type TestIssuer,
  type TokenOptions,
} from './test-issuer.ts';

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

const identityKey = ({ issuer, subject }: Identity) => `${issuer}\n${subject}`;

/** Identity mapping held in memory: the default in gateway tests (no user-service). */
export class InMemoryIdentityResolver extends IdentityResolver {
  readonly users = new Map<string, ResolvedUser>();

  async resolve(identity: Identity): Promise<ResolvedUser | null> {
    return this.users.get(identityKey(identity)) ?? null;
  }

  forget(): void {}

  forgetUser(): void {}

  register(identity: Identity, user: ResolvedUser): void {
    this.users.set(identityKey(identity), user);
  }
}

export interface TestGateway {
  readonly app: NestFastifyApplication;
  /** The identity provider the gateway trusts (a local JWKS server). */
  readonly issuer: TestIssuer;
  /** The in-memory identity mapping (unless the real resolver was requested). */
  readonly identities: InMemoryIdentityResolver;
  inject(options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    payload?: object;
    headers?: Record<string, string>;
  }): Promise<InjectResponse>;
  /** Authorization header with a token of the test issuer for login `sub`. */
  bearer(sub: string, options?: Omit<TokenOptions, 'sub'>): Promise<Record<string, string>>;
  /** Authorization header of a registered user (a fresh login mapped to `userId`). */
  as(userId: string, roles?: readonly Role[]): Promise<Record<string, string>>;
  close(): Promise<void>;
}

/** Gateway files allowed to add routes, hooks and middleware outside controllers. */
const RAW_HTTP_FILES = new Set(['src/bootstrap.ts', 'src/http/openapi.ts']);
/** Routes outside controllers: the OpenAPI document, and CORS preflight when CORS is on. */
const NON_CONTROLLER_ROUTES = new Set(['GET /openapi.json', 'HEAD /openapi.json', 'OPTIONS *']);
const GATEWAY_FILE = /\/apps\/gateway\/(src\/[^:)]+\.ts)/;

/** Stack frames above the caller, this file and Node's own frames left out. */
function callers(): string[] {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 100;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  return stack
    .split('\n')
    .slice(1)
    .filter((frame) => !frame.includes('/apps/gateway/test/harness.ts'))
    .filter((frame) => !frame.includes('node:internal') && !frame.includes('(native)'));
}

/**
 * Who called a registration method: the gateway source file that called it, `library`
 * when a package did, or `unknown` when nothing can be named (a call scheduled from a
 * microtask, for instance), which counts as a gateway file other than the allowed two.
 */
function caller(): string {
  const first = callers()[0] ?? '';
  const own = GATEWAY_FILE.exec(first);
  if (own) return own[1] as string;
  return first.includes('/node_modules/') ? 'library' : 'unknown';
}

/** Who registered a route: Nest's router, a gateway file anywhere on the stack, or else. */
function routeOwner(): string {
  const frames = callers();
  if (frames.some((frame) => frame.includes('/@nestjs/core/router/'))) return 'nest';
  for (const frame of frames) {
    const own = GATEWAY_FILE.exec(frame);
    if (own) return own[1] as string;
  }
  return frames.some((frame) => frame.includes('/node_modules/')) ? 'library' : 'unknown';
}

/** What the HTTP server got besides controller routes while the gateway started. */
interface Registrations {
  readonly routes: { readonly route: string; readonly by: string }[];
  readonly hooks: { readonly what: string; readonly by: string }[];
}

/** The gateway being created; Nest middleware (consumer.apply) is recorded into it. */
let recording: Registrations | undefined;
const apply = MiddlewareBuilder.prototype.apply;
MiddlewareBuilder.prototype.apply = function (this: MiddlewareBuilder, ...middleware) {
  recording?.hooks.push({ what: 'Nest middleware (consumer.apply)', by: caller() });
  return apply.apply(this, middleware);
};

/** Wraps `target[name]` so each call is recorded with the code that made it. */
function track(target: object, name: string, into: Registrations): void {
  const original = (target as Record<string, unknown>)[name];
  if (typeof original !== 'function') return;
  (target as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
    into.hooks.push({ what: `${name}(${String(args[0])})`, by: caller() });
    return (original as (...rest: unknown[]) => unknown).apply(this, args);
  };
}

/** Records every route, hook, plugin, handler and middleware the server gets, and who added it. */
function recordRegistrations(adapter: ReturnType<typeof createAdapter>): Registrations {
  const registrations: Registrations = { routes: [], hooks: [] };
  const fastify = adapter.getInstance();
  fastify.addHook('onRoute', (route: { method: string | string[]; url: string }) => {
    const by = routeOwner();
    for (const verb of [route.method].flat()) {
      registrations.routes.push({ route: `${verb} ${route.url}`, by });
    }
  });
  for (const name of ['addHook', 'register', 'setNotFoundHandler', 'setErrorHandler']) {
    track(fastify, name, registrations);
  }
  track(adapter, 'use', registrations);
  // @fastify/middie adds the instance's own `use` while Nest starts: wrap it on arrival.
  const decorate = fastify.decorate;
  (fastify as unknown as Record<string, unknown>).decorate = function (
    this: unknown,
    ...args: unknown[]
  ) {
    const result: unknown = Reflect.apply(decorate, this, args);
    if (args[0] === 'use') track(fastify, 'use', registrations);
    return result;
  };
  return registrations;
}

/**
 * Fails unless every route is a controller route (so AuthGuard sees it) or one of the
 * known exceptions, and nothing but packages and the gateway's bootstrap.ts and
 * http/openapi.ts added hooks, plugins, handlers or middleware (ADR-0004). Runs once
 * Fastify is ready, so registrations deferred to its boot are seen too.
 */
function expectOnlyGuardedRoutes(seen: Registrations): void {
  const allowedFrom = (by: string) => by === 'nest' || by === 'library' || RAW_HTTP_FILES.has(by);
  const stray = seen.routes.filter(
    ({ route, by }) => by !== 'nest' && !(NON_CONTROLLER_ROUTES.has(route) && allowedFrom(by)),
  );
  const hooks = seen.hooks.filter(({ by }) => !allowedFrom(by));
  if (stray.length > 0 || hooks.length > 0) {
    throw new Error(
      [
        'the gateway serves requests outside its controllers, so AuthGuard never sees them (ADR-0004):',
        ...stray.map(({ route, by }) => `  route ${route} (from ${by})`),
        ...hooks.map(({ what, by }) => `  ${what} (from ${by})`),
      ].join('\n'),
    );
  }
}

let keys: Promise<TestWorkloadKeys> | undefined;
let issuer: Promise<TestIssuer> | undefined;
let logins = 0;

/**
 * Boots the real gateway (production adapter, configuration and AuthGuard, TLS off)
 * with the given gRPC client tokens replaced by fakes:
 * `createTestGateway(new Map([[USER_SERVICE, fakeUsers]]))`. Clients that are not
 * overridden get an empty object. Pass `{ realResolver: true }` to resolve identities
 * through the (fake) user-service client instead of the in-memory map. Fails unless the
 * routes open without a registered user, as AuthGuard enforces them, are exactly those
 * security/public-endpoints.json lists for the gateway, and unless every route is served
 * by a controller (ADR-0004).
 */
export async function createTestGateway(
  clients: ReadonlyMap<symbol, unknown>,
  options: {
    readonly realResolver?: boolean;
    readonly env?: Record<string, string>;
    /** Extra modules next to AppModule (the harness's own tests). */
    readonly imports?: readonly Type[];
  } = {},
): Promise<TestGateway> {
  // One gateway key and one identity provider per test process.
  keys ??= createTestWorkloadKeys(['gateway']);
  issuer ??= createTestIssuer();
  const idp = await issuer;
  Object.assign(process.env, TEST_ENV, (await keys).env('gateway'), {
    AUTH_ISSUERS: JSON.stringify([
      {
        issuer: idp.issuer,
        audience: TEST_AUDIENCE,
        jwksUri: idp.jwksUri,
        userinfoUri: idp.userinfoUri,
      },
    ]),
    AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S: '0',
    ...options.env,
  });
  const config = parseConfig(ConfigSchema);
  const identities = new InMemoryIdentityResolver();
  let builder = Test.createTestingModule({ imports: [AppModule, ...(options.imports ?? [])] });
  for (const [token, fake] of clients) builder = builder.overrideProvider(token).useValue(fake);
  if (!options.realResolver)
    builder = builder.overrideProvider(IdentityResolver).useValue(identities);
  const moduleRef = await builder.compile();
  const adapter = createAdapter(config);
  const registrations = recordRegistrations(adapter);
  const app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
  const fastify = app.getHttpAdapter().getInstance();
  recording = registrations;
  try {
    configureGateway(app, config);
    await app.init();
    await fastify.ready();
    expectListedOpenEndpoints('apps/gateway', app.get(AuthRoutes).open);
    expectOnlyGuardedRoutes(registrations);
  } catch (error) {
    await app.close();
    throw error;
  } finally {
    recording = undefined;
  }
  const bearer = async (sub: string, tokenOptions: Omit<TokenOptions, 'sub'> = {}) => ({
    authorization: `Bearer ${await idp.token({ sub, ...tokenOptions })}`,
  });
  return {
    app,
    issuer: idp,
    identities,
    inject: (request) => fastify.inject(request),
    bearer,
    as: async (userId, roles = []) => {
      logins += 1;
      const subject = `login-${logins}`;
      identities.register({ issuer: idp.issuer, subject }, { userId, roles });
      return bearer(subject);
    },
    close: () => app.close(),
  };
}
