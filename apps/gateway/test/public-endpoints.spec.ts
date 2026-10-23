import { expectListedOpenEndpoints } from '@ga/service-kit/testing';
import { applyDecorators, Controller, Get, SetMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AllowUnregistered, AUTH_ROUTE, Public as Open } from '../src/auth/decorators.ts';
import { HealthController } from '../src/health/health.controller.ts';
import { HousesController } from '../src/houses/houses.controller.ts';
import { UsersController } from '../src/users/users.controller.ts';
import { openRoutes } from './harness.ts';

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

const gateway = [HealthController, HousesController, UsersController];

describe('security/public-endpoints.json at runtime', () => {
  it('lists exactly the routes the gateway opens', () => {
    expect(() => expectListedOpenEndpoints('apps/gateway', openRoutes(gateway))).not.toThrow();
  });

  it('sees routes opened by a wrapper, an alias or raw metadata', () => {
    expect(openRoutes([ProbeController, ClassWideController])).toEqual([
      { member: 'ProbeController.wrapped', access: 'public', reason: 'world-readable catalogue' },
      { member: 'ProbeController.raw', access: 'public', reason: 'raw' },
      { member: 'ProbeController.signup', access: 'unregistered', reason: 'registration' },
      { member: 'ClassWideController', access: 'public', reason: 'everything' },
    ]);
    expect(() =>
      expectListedOpenEndpoints('apps/gateway', openRoutes([...gateway, ProbeController])),
    ).toThrow('open but not listed: ProbeController.wrapped [public] world-readable catalogue');
  });
});
