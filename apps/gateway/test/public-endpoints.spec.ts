import { expectListedOpenEndpoints } from '@ga/service-kit/testing';
import { applyDecorators, Controller, Get, SetMetadata, type Type } from '@nestjs/common';
import { type DiscoveryService, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRoutes, authRoutesOf } from '../src/auth/auth-routes.ts';
import { AllowUnregistered, AUTH_ROUTE, Public as Open } from '../src/auth/decorators.ts';
import { UsersController } from '../src/users/users.controller.ts';
import { createTestGateway, type TestGateway } from './harness.ts';

// Ways of opening a route that tools/check-access.ts refuses in source but that the
// metadata still shows (these files are tests, so the source check skips them).
const Catalogue = () => applyDecorators(Get('wrapped'), Open('world-readable catalogue'));

@Controller('probe')
class ProbeController {
  @Catalogue()
  wrapped() {}

  @Get('raw')
  @SetMetadata(AUTH_ROUTE, { mode: 'public', reason: 'raw', ignoreToken: false })
  raw() {}

  @Get('signup')
  @AllowUnregistered()
  signup() {}

  @Get('user')
  user() {}
}

@Controller('closed')
@Open('everything')
class ClassWideController {
  @Get()
  list() {}
}

class Listing {
  @Get()
  list() {}
}

@Controller('catalogue')
@Open('world-readable catalogue')
class CatalogueController extends Listing {}

@Controller('private')
class PrivateController extends Listing {}

@Controller('bound')
class BoundController {
  constructor() {
    this.list = this.list.bind(this);
  }

  @Get()
  @Open('bound')
  list() {}
}

/** AuthRoutes over these controllers, as the gateway builds it at boot. */
function recordOf(...types: Type[]): AuthRoutes {
  const controllers = types.map((type) => ({ metatype: type, instance: new type() }));
  const routes = new AuthRoutes(
    { getControllers: () => controllers } as unknown as DiscoveryService,
    new Reflector(),
  );
  routes.onModuleInit();
  return routes;
}

describe('AuthRoutes', () => {
  it('keeps the mode of an inherited handler per controller', () => {
    const routes = recordOf(CatalogueController, PrivateController);
    expect(routes.routeOf(CatalogueController, Listing.prototype.list)).toMatchObject({
      mode: 'public',
    });
    expect(routes.routeOf(PrivateController, Listing.prototype.list)).toBeUndefined();
  });

  it('knows handlers bound on the instance, and refuses anything else', () => {
    const controller = new BoundController();
    const routes = new AuthRoutes(
      {
        getControllers: () => [{ metatype: BoundController, instance: controller }],
      } as unknown as DiscoveryService,
      new Reflector(),
    );
    routes.onModuleInit();
    expect(routes.routeOf(BoundController, controller.list)).toMatchObject({ mode: 'public' });
    expect(routes.routeOf(BoundController, () => undefined)).toBe('unknown');
  });
});

describe('security/public-endpoints.json at runtime', () => {
  let gateway: TestGateway;

  beforeAll(async () => {
    gateway = await createTestGateway(new Map());
  });

  afterAll(async () => {
    await gateway?.close();
  });

  it('sees routes opened by a wrapper, an alias or raw metadata', () => {
    expect(authRoutesOf([{ type: ProbeController }, { type: ClassWideController }]).open).toEqual([
      { member: 'ProbeController.wrapped', access: 'public', reason: 'world-readable catalogue' },
      { member: 'ProbeController.raw', access: 'public', reason: 'raw' },
      { member: 'ProbeController.signup', access: 'unregistered', reason: 'registration' },
      { member: 'ClassWideController', access: 'public', reason: 'everything' },
    ]);
    const open = [
      ...gateway.app.get(AuthRoutes).open,
      ...authRoutesOf([{ type: ProbeController }]).open,
    ];
    expect(() => expectListedOpenEndpoints('apps/gateway', open)).toThrow(
      'open but not listed: ProbeController.wrapped [public] world-readable catalogue',
    );
  });

  it('enforces the routes recorded at boot, not metadata written later', async () => {
    const handler = UsersController.prototype.get as object;
    Reflect.defineMetadata(
      AUTH_ROUTE,
      { mode: 'public', reason: 'late', ignoreToken: true },
      handler,
    );
    try {
      // The guard itself refuses (not the handler, which would also fail without a user).
      const response = await gateway.inject({ method: 'GET', url: '/v1/users/me' });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('AUTH_TOKEN_MISSING');
    } finally {
      Reflect.deleteMetadata(AUTH_ROUTE, handler);
    }
  });
});
