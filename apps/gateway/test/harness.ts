import type { Role } from '@ga/kernel';
import { parseConfig } from '@ga/service-kit';
import {
  createTestWorkloadKeys,
  expectListedOpenEndpoints,
  type TestWorkloadKeys,
} from '@ga/service-kit/testing';
import { ModulesContainer } from '@nestjs/core';
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

/** Modules that mount Nest middleware: request logging and the request context only. */
const MIDDLEWARE_MODULES = new Set(['LoggerModule', 'ClsRootModule']);
/** Gateway files allowed to add routes, hooks and middleware outside controllers. */
const RAW_HTTP_FILES = new Set(['src/bootstrap.ts', 'src/http/openapi.ts']);
/** Routes outside controllers: the OpenAPI document, and CORS preflight when CORS is on. */
const NON_CONTROLLER_ROUTES = new Set(['GET /openapi.json', 'HEAD /openapi.json', 'OPTIONS *']);

/** Who registered something: the gateway source file on the call stack, `nest` or `library`. */
function registeredBy(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 100;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  if (stack.includes('/@nestjs/core/router/')) return 'nest';
  const own = /\/apps\/gateway\/(src\/[^:)]+\.ts)/.exec(stack);
  return own?.[1] ?? 'library';
}

/** What the HTTP server got besides controller routes while the gateway started. */
interface Registrations {
  readonly routes: { readonly route: string; readonly by: string }[];
  readonly hooks: { readonly what: string; readonly by: string }[];
}

/** Records every route, hook, plugin and middleware the adapter gets, and who added it. */
function recordRegistrations(adapter: ReturnType<typeof createAdapter>): Registrations {
  const registrations: Registrations = { routes: [], hooks: [] };
  const fastify = adapter.getInstance();
  fastify.addHook('onRoute', (route: { method: string | string[]; url: string }) => {
    const by = registeredBy();
    for (const verb of [route.method].flat()) {
      registrations.routes.push({ route: `${verb} ${route.url}`, by });
    }
  });
  const track = <T extends object>(target: T, name: string) => {
    const original = (target as Record<string, unknown>)[name];
    if (typeof original !== 'function') return;
    (target as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      registrations.hooks.push({ what: `${name}(${String(args[0])})`, by: registeredBy() });
      return (original as (...rest: unknown[]) => unknown).apply(this, args);
    };
  };
  track(fastify, 'addHook');
  track(fastify, 'register');
  track(adapter, 'use');
  return registrations;
}

/**
 * Fails unless every route is a controller route (so AuthGuard sees it) or one of the
 * known exceptions added by bootstrap.ts / http/openapi.ts or a plugin, no gateway file
 * but those two adds hooks, plugins or middleware, and no module but logging and the
 * request context mounts Nest middleware (ADR-0004).
 */
function expectOnlyGuardedRoutes(app: NestFastifyApplication, seen: Registrations): void {
  const allowedFrom = (by: string) => by === 'nest' || by === 'library' || RAW_HTTP_FILES.has(by);
  const stray = seen.routes.filter(
    ({ route, by }) => by !== 'nest' && !(NON_CONTROLLER_ROUTES.has(route) && allowedFrom(by)),
  );
  const hooks = seen.hooks.filter(({ by }) => !allowedFrom(by));
  const middleware = [...app.get(ModulesContainer).values()]
    .map((module) => module.metatype as { name: string; prototype?: { configure?: unknown } })
    .filter(
      ({ name, prototype }) =>
        typeof prototype?.configure === 'function' && !MIDDLEWARE_MODULES.has(name),
    )
    .map(({ name }) => name);
  if (stray.length > 0 || hooks.length > 0 || middleware.length > 0) {
    throw new Error(
      [
        'the gateway serves requests outside its controllers, so AuthGuard never sees them (ADR-0004):',
        ...stray.map(({ route, by }) => `  route ${route} (from ${by})`),
        ...hooks.map(({ what, by }) => `  ${what} (from ${by})`),
        ...middleware.map((name) => `  Nest middleware from ${name}`),
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
  options: { readonly realResolver?: boolean; readonly env?: Record<string, string> } = {},
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
  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const [token, fake] of clients) builder = builder.overrideProvider(token).useValue(fake);
  if (!options.realResolver)
    builder = builder.overrideProvider(IdentityResolver).useValue(identities);
  const moduleRef = await builder.compile();
  const adapter = createAdapter(config);
  const registrations = recordRegistrations(adapter);
  const app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
  configureGateway(app, config);
  await app.init();
  try {
    expectListedOpenEndpoints('apps/gateway', app.get(AuthRoutes).open);
    expectOnlyGuardedRoutes(app, registrations);
  } catch (error) {
    await app.close();
    throw error;
  }
  const fastify = app.getHttpAdapter().getInstance();
  await fastify.ready();
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
