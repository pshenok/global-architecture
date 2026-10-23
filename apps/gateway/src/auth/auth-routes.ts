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

/**
 * The auth mode of each route handler of these controllers, as the guard applies it (the
 * method's own decorator wins over its controller's), and the routes open without a
 * registered user.
 */
export function authRoutesOf(
  controllers: readonly Type[],
  reflector = new Reflector(),
): { handlers: Map<object, AuthRoute | undefined>; open: OpenRoute[] } {
  const scanner = new MetadataScanner();
  const handlers = new Map<object, AuthRoute | undefined>();
  const open: OpenRoute[] = [];
  const add = (member: string, route: AuthRoute | undefined) => {
    if (route?.mode === 'public') open.push({ member, access: 'public', reason: route.reason });
    if (route?.mode === 'unregistered') {
      open.push({ member, access: 'unregistered', reason: 'registration' });
    }
  };
  for (const controller of controllers) {
    add(controller.name, reflector.get<AuthRoute | undefined>(AUTH_ROUTE, controller));
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name];
      if (
        typeof handler !== 'function' ||
        Reflect.getMetadata(METHOD_METADATA, handler) === undefined
      ) {
        continue;
      }
      handlers.set(
        handler,
        reflector.getAllAndOverride<AuthRoute | undefined>(AUTH_ROUTE, [handler, controller]),
      );
      add(`${controller.name}.${name}`, reflector.get<AuthRoute | undefined>(AUTH_ROUTE, handler));
    }
  }
  return { handlers, open };
}

/**
 * The auth mode of every gateway route, recorded once at boot (ADR-0004). AuthGuard
 * enforces this record and createTestGateway compares `open` with
 * security/public-endpoints.json, so what the tests check is what runs: metadata changed
 * after boot changes nothing, and a handler that was not a route at boot is refused.
 */
@Injectable()
export class AuthRoutes implements OnModuleInit {
  private handlers = new Map<object, AuthRoute | undefined>();
  private recorded: readonly OpenRoute[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const controllers = this.discovery
      .getControllers()
      .flatMap(({ metatype }) => (typeof metatype === 'function' ? [metatype as Type] : []));
    const { handlers, open } = authRoutesOf(controllers, this.reflector);
    this.handlers = handlers;
    this.recorded = Object.freeze(open);
  }

  /** Routes open without a registered user. */
  get open(): readonly OpenRoute[] {
    return this.recorded;
  }

  /** The recorded mode of a handler (undefined: a registered user); `unknown` if none. */
  routeOf(handler: object): AuthRoute | undefined | 'unknown' {
    return this.handlers.has(handler) ? this.handlers.get(handler) : 'unknown';
  }
}
