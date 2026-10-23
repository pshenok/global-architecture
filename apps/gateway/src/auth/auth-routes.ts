import { Injectable, type OnModuleInit, type Type } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { AUTH_ROUTE, type AuthRoute } from './decorators.ts';

/** A route that needs no registered user, as security/public-endpoints.json lists it. */
export interface OpenRoute {
  /** `Class.method`, or `Class` for a decorator on the controller. */
  readonly member: string;
  readonly access: 'public' | 'unregistered';
  readonly reason: string;
}

/** Route modes by controller, then by handler (the prototype method and any bound copy). */
type RouteTable = Map<Type, Map<object, AuthRoute | undefined>>;

/**
 * The auth mode of each route of these controllers, as the guard applies it (the method's
 * own decorator wins over its controller's), and the routes open without a registered
 * user. Modes are kept per controller: two controllers that inherit one handler from a
 * base class can differ (a class-level @Public on one must not open the other).
 */
export function authRoutesOf(
  controllers: readonly { readonly type: Type; readonly instance?: unknown }[],
  reflector = new Reflector(),
): { routes: RouteTable; open: OpenRoute[] } {
  const scanner = new MetadataScanner();
  const routes: RouteTable = new Map();
  const open: OpenRoute[] = [];
  const add = (member: string, route: AuthRoute | undefined) => {
    if (route?.mode === 'public') open.push({ member, access: 'public', reason: route.reason });
    if (route?.mode === 'unregistered') {
      open.push({ member, access: 'unregistered', reason: 'registration' });
    }
  };
  for (const { type, instance } of controllers) {
    const handlers = new Map<object, AuthRoute | undefined>();
    routes.set(type, handlers);
    add(type.name, reflector.get<AuthRoute | undefined>(AUTH_ROUTE, type));
    const prototype = type.prototype as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name];
      if (
        typeof handler !== 'function' ||
        Reflect.getMetadata(METHOD_METADATA, handler) === undefined
      ) {
        continue;
      }
      const route = reflector.getAllAndOverride<AuthRoute | undefined>(AUTH_ROUTE, [handler, type]);
      handlers.set(handler, route);
      // Nest calls instance[name]: a method bound in the constructor is another function.
      const bound = (instance as Record<string, unknown> | undefined)?.[name];
      if (typeof bound === 'function') handlers.set(bound, route);
      add(`${type.name}.${name}`, reflector.get<AuthRoute | undefined>(AUTH_ROUTE, handler));
    }
  }
  return { routes, open };
}

/**
 * The auth mode of every gateway route, recorded once at boot (ADR-0004). AuthGuard
 * enforces this record and createTestGateway compares `open` with
 * security/public-endpoints.json, so what the tests check is what runs: metadata changed
 * after boot changes nothing, and a handler that was not a route at boot is refused.
 */
@Injectable()
export class AuthRoutes implements OnModuleInit {
  private routes: RouteTable = new Map();
  private recorded: readonly OpenRoute[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const controllers = this.discovery
      .getControllers()
      .flatMap(({ metatype, instance }) =>
        typeof metatype === 'function'
          ? [{ type: metatype as Type, instance: instance as unknown }]
          : [],
      );
    const { routes, open } = authRoutesOf(controllers, this.reflector);
    this.routes = routes;
    this.recorded = Object.freeze(open);
  }

  /** Routes open without a registered user. */
  get open(): readonly OpenRoute[] {
    return this.recorded;
  }

  /** The recorded mode of a controller's handler (undefined: a registered user); `unknown` if none. */
  routeOf(controller: Type, handler: object): AuthRoute | undefined | 'unknown' {
    const handlers = this.routes.get(controller);
    return handlers?.has(handler) ? handlers.get(handler) : 'unknown';
  }
}
