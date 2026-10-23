import { expectListedOpenEndpoints } from '@ga/service-kit/testing';
import { applyDecorators, Controller, Get, SetMetadata } from '@nestjs/common';
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

describe('security/public-endpoints.json at runtime', () => {
  let gateway: TestGateway;

  beforeAll(async () => {
    gateway = await createTestGateway(new Map());
  });

  afterAll(async () => {
    await gateway?.close();
  });

  it('sees routes opened by a wrapper, an alias or raw metadata', () => {
    expect(authRoutesOf([ProbeController, ClassWideController]).open).toEqual([
      { member: 'ProbeController.wrapped', access: 'public', reason: 'world-readable catalogue' },
      { member: 'ProbeController.raw', access: 'public', reason: 'raw' },
      { member: 'ProbeController.signup', access: 'unregistered', reason: 'registration' },
      { member: 'ClassWideController', access: 'public', reason: 'everything' },
    ]);
    const open = [...gateway.app.get(AuthRoutes).open, ...authRoutesOf([ProbeController]).open];
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
