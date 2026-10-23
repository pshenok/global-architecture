import type { Role } from '@ga/kernel';
import { parseConfig } from '@ga/service-kit';
import {
  createTestWorkloadKeys,
  type DeclaredOpenEndpoint,
  expectListedOpenEndpoints,
  type TestWorkloadKeys,
} from '@ga/service-kit/testing';
import type { Type } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.ts';
import { AUTH_ROUTE, type AuthRoute } from '../src/auth/decorators.ts';
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

/**
 * Routes of these controllers that need no registered user, read from the metadata the
 * auth guard reads (a method's own route wins over its class's), whatever spelling put it
 * there.
 */
export function openRoutes(controllers: readonly Type[]): DeclaredOpenEndpoint[] {
  const scanner = new MetadataScanner();
  const open: DeclaredOpenEndpoint[] = [];
  const add = (member: string, route: AuthRoute | undefined) => {
    if (route?.mode === 'public') open.push({ member, access: 'public', reason: route.reason });
    if (route?.mode === 'unregistered')
      open.push({ member, access: 'unregistered', reason: 'registration' });
  };
  for (const controller of controllers) {
    add(controller.name, Reflect.getMetadata(AUTH_ROUTE, controller) as AuthRoute | undefined);
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name] as object;
      if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
      add(
        `${controller.name}.${name}`,
        Reflect.getMetadata(AUTH_ROUTE, handler) as AuthRoute | undefined,
      );
    }
  }
  return open;
}

/** Every controller the app registered. */
function controllersOf(app: NestFastifyApplication): Type[] {
  return [...app.get(ModulesContainer).values()].flatMap((module) =>
    [...module.controllers.values()].flatMap(({ metatype }) =>
      typeof metatype === 'function' ? [metatype as Type] : [],
    ),
  );
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
 * routes open without a registered user are exactly those security/public-endpoints.json
 * lists for the gateway (ADR-0004).
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
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(config));
  configureGateway(app, config);
  await app.init();
  try {
    expectListedOpenEndpoints('apps/gateway', openRoutes(controllersOf(app)));
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
