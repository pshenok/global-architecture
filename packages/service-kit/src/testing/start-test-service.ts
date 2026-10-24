import type { Role, UserActor } from '@ga/kernel';
import { Metadata } from '@grpc/grpc-js';
import type { INestMicroservice, Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AccessPolicyCheck } from '../auth/access-policy-check.ts';
import {
  CALLER_METADATA_KEY,
  PRINCIPAL_METADATA_KEY,
  type PrincipalClaims,
  signCallerToken,
  signPrincipalToken,
} from '../auth/tokens.ts';
import { bootstrapGrpcService } from '../grpc/bootstrap.ts';
import type { ServiceDefinition } from '../platform/service-definition.ts';
import { freePort } from './free-port.ts';
import { createGrpcTestClient, type GrpcTestClient } from './grpc-test-client.ts';
import { expectListedOpenEndpoints, ownPackageDir } from './public-endpoints.ts';
import { createTestWorkloadKeys, type TestWorkloadKeys } from './workload-keys.ts';

/** The edge that signs principals in tests, as in production. */
const EDGE = 'gateway';

export interface CallOptions {
  /** Workload making the call (default: the gateway). Must be listed in `callers`. */
  readonly caller?: string;
}

export interface TestService {
  readonly app: INestMicroservice;
  /** `127.0.0.1:<port>` the service listens on. */
  readonly url: string;
  /** Keys of the gateway, this service and `callers`, for tests that forge tokens. */
  readonly keys: TestWorkloadKeys;
  /** Metadata of a call on behalf of a registered user (principal signed by the gateway). */
  as(
    user: string | UserActor,
    options?: CallOptions & { readonly roles?: readonly Role[] },
  ): Promise<Metadata>;
  /** Metadata of a call on behalf of an IdP identity that has no user yet. */
  asIdentity(
    identity: { readonly issuer: string; readonly subject: string; readonly email?: string | null },
    options?: CallOptions,
  ): Promise<Metadata>;
  /** Metadata of a workload calling as itself (no principal). */
  asService(name: string): Promise<Metadata>;
  /** Metadata of an anonymous call through the gateway (no principal). */
  anonymous(options?: CallOptions): Promise<Metadata>;
  /** A typed client of this service whose calls default to `anonymous()`. */
  client<C>(grpcService: string): GrpcTestClient<C>;
  close(): Promise<void>;
}

/**
 * Boots a real gRPC service in-process on a free port, exactly like main.ts does
 * (same filter, auth guard, health, reflection, logging), with optional provider
 * overrides and ephemeral workload keys. In the service's own package (apps/<name>) it
 * also fails unless the methods open without a user are exactly those that
 * security/public-endpoints.json lists for it (ADR-0004).
 */
export async function startTestService(options: {
  readonly module: Type<unknown>;
  readonly service: ServiceDefinition;
  /** Extra environment (e.g. DATABASE_URL from createTestDatabase). */
  readonly env?: Readonly<Record<string, string>>;
  /** e.g. `(b) => b.overrideProvider(UserDirectory).useValue(fake)` */
  readonly override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /** Workloads besides the gateway that call this service in the test. */
  readonly callers?: readonly string[];
  /**
   * Keys shared with another test service (its `keys`), so the two trust each other;
   * they must include this service. The other service owns and disposes them.
   */
  readonly keys?: TestWorkloadKeys;
}): Promise<TestService> {
  const self = options.service.name;
  const ownKeys = !options.keys;
  const keys =
    options.keys ?? (await createTestWorkloadKeys([EDGE, self, ...(options.callers ?? [])]));
  const port = await freePort();
  const url = `127.0.0.1:${port}`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    GRPC_HOST: '127.0.0.1',
    GRPC_PORT: String(port),
    // Event loops stay off (tests drive them with flushOutbox/deliverEvent); nothing listens here.
    EVENTS_AUTOSTART: 'false',
    EVENT_BUS_SERVICE_URL: '127.0.0.1:1',
    ...keys.env(self),
    ...options.env,
  });
  let builder = Test.createTestingModule({ imports: [options.module] });
  if (options.override) builder = options.override(builder);
  const moduleRef = await builder.compile();
  let app: INestMicroservice;
  try {
    app = await bootstrapGrpcService(moduleRef, options.service, { url, shutdownHooks: false });
  } catch (error) {
    if (ownKeys) keys.dispose();
    throw error;
  }
  const packageDir = ownPackageDir(self);
  if (packageDir) {
    try {
      expectListedOpenEndpoints(packageDir, app.get(AccessPolicyCheck).open);
    } catch (error) {
      await app.close();
      if (ownKeys) keys.dispose();
      throw error;
    }
  }

  const callerOnly = async (caller: string) => {
    const metadata = new Metadata();
    metadata.set(
      CALLER_METADATA_KEY,
      await signCallerToken(await keys.signingKey(caller), caller, self),
    );
    return metadata;
  };
  const withPrincipal = async (claims: PrincipalClaims, caller = EDGE) => {
    const metadata = await callerOnly(caller);
    const principal = await signPrincipalToken(await keys.signingKey(EDGE), EDGE, claims, 60);
    metadata.set(PRINCIPAL_METADATA_KEY, principal);
    return metadata;
  };

  const service: TestService = {
    app,
    url,
    keys,
    as: (user, callOptions = {}) =>
      withPrincipal(
        typeof user === 'string'
          ? { kind: 'user', userId: user, roles: [...(callOptions.roles ?? [])] }
          : { kind: 'user', userId: user.userId, roles: [...user.roles] },
        callOptions.caller,
      ),
    asIdentity: (identity, callOptions = {}) =>
      withPrincipal(
        {
          kind: 'identity',
          issuer: identity.issuer,
          subject: identity.subject,
          email: identity.email ?? null,
        },
        callOptions.caller,
      ),
    asService: (name) => callerOnly(name),
    anonymous: (callOptions = {}) => callerOnly(callOptions.caller ?? EDGE),
    client: <C>(grpcService: string) =>
      createGrpcTestClient<C>(grpcService, options.service.protoFiles, url, {
        metadata: () => service.anonymous(),
      }),
    close: async () => {
      await app.close();
      if (ownKeys) keys.dispose();
    },
  };
  return service;
}
