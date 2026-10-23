/**
 * Access policy of a gRPC method (ADR-0004). Every RPC handler must declare exactly
 * one; a service with an undeclared handler refuses to start, and the guard denies
 * an undeclared call at runtime.
 *
 *   @Access.user()                                  a registered user, principal from an edge
 *   @Access.user({ via: ['booking-service'] })      ... or forwarded by booking-service
 *   @Access.admin()                                 a user with the admin role
 *   @Access.identity()                              an IdP login without a user (registration)
 *   @Access.service(['booking-service'])            a workload acting as itself, no user
 *   @Access.public('world-readable catalogue')      anyone; the handler never sees who
 *
 * Every call must carry a valid caller assertion, public ones included.
 */
export const ACCESS_POLICY = 'ga:access-policy';

export type AccessPolicy =
  | { readonly kind: 'public'; readonly reason: string }
  | { readonly kind: 'user' | 'admin' | 'identity'; readonly via: readonly string[] }
  | { readonly kind: 'service'; readonly callers: readonly string[] };

const WORKLOAD = /^[a-z][a-z0-9-]*[a-z0-9]$/;

function checkWorkloads(names: readonly string[], what: string): readonly string[] {
  for (const name of names) {
    if (!WORKLOAD.test(name)) throw new TypeError(`${what}: "${name}" is not a workload name`);
  }
  return Object.freeze([...names]);
}

function declare(policy: AccessPolicy): MethodDecorator {
  return (_target, _key, descriptor) => {
    const handler = descriptor.value as object | undefined;
    if (typeof handler !== 'function') throw new TypeError('@Access decorates methods');
    if (Reflect.hasMetadata(ACCESS_POLICY, handler)) {
      throw new TypeError(`${String(_key)} declares more than one @Access policy`);
    }
    Reflect.defineMetadata(ACCESS_POLICY, Object.freeze(policy), handler);
  };
}

interface ViaOptions {
  /** Services allowed to forward the user's principal to this method (besides the edges). */
  readonly via?: readonly string[];
}

export const Access = {
  public(reason: string): MethodDecorator {
    if (!reason.trim()) throw new TypeError('@Access.public needs a reason');
    return declare({ kind: 'public', reason });
  },
  user(options: ViaOptions = {}): MethodDecorator {
    return declare({ kind: 'user', via: checkWorkloads(options.via ?? [], '@Access.user via') });
  },
  admin(options: ViaOptions = {}): MethodDecorator {
    return declare({ kind: 'admin', via: checkWorkloads(options.via ?? [], '@Access.admin via') });
  },
  identity(options: ViaOptions = {}): MethodDecorator {
    return declare({
      kind: 'identity',
      via: checkWorkloads(options.via ?? [], '@Access.identity via'),
    });
  },
  service(callers: readonly string[]): MethodDecorator {
    if (callers.length === 0) throw new TypeError('@Access.service needs at least one caller');
    return declare({ kind: 'service', callers: checkWorkloads(callers, '@Access.service') });
  },
};

/** The policy a handler declared, if any. */
export function accessPolicyOf(handler: object): AccessPolicy | undefined {
  return Reflect.getMetadata(ACCESS_POLICY, handler) as AccessPolicy | undefined;
}
