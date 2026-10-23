/**
 * Self-test of tools/check-access.ts, which reads this file as if it were production code
 * in the gateway: every line marked `refused` must be refused, and no other line. Each
 * probe is a way to open a route without a listed, reviewed decorator that a review found.
 * Nothing imports or runs this file.
 */
import { createRequire } from 'node:module'; // refused
import {
  applyDecorators,
  Controller,
  Get,
  Inject,
  Injectable,
  type MiddlewareConsumer, // refused
  type NestModule, // refused
  SetMetadata,
} from '@nestjs/common';
import { DiscoveryService, HttpAdapterHost } from '@nestjs/core'; // refused
import * as auth from '../../src/auth/decorators.ts';
import {
  AllowUnregistered,
  AUTH_ROUTE,
  Public as Open, // refused
  Public,
} from '../../src/auth/decorators.ts';

const Maintenance = () => Public('maintenance'); // refused
const Catalogue = () => applyDecorators(Get(), Public('catalogue')); // refused
const keep = <T>(_: TemplateStringsArray, value: T) => value;
const openly = keep`${Public('partner feed')}`; // refused
const shorthand = { Public }; // refused
const TAG = ['ga', 'auth-route'].join(':');
const load = createRequire(import.meta.url); // refused

@Controller('probe')
export class ProbeController {
  @Get('listed')
  @Public('world-readable catalogue')
  listed() {
    return load;
  }

  @Get('signup')
  @AllowUnregistered()
  signup() {}

  @Get('ns')
  @auth.Public('namespace') // refused
  namespace() {}

  @Get('raw')
  @SetMetadata(AUTH_ROUTE, { mode: 'public' }) // refused
  raw() {}

  @Get('key')
  @SetMetadata('ga:auth-route', { mode: 'public' }) // refused
  key() {
    Reflect.defineMetadata(TAG, { mode: 'public' }, ProbeController.prototype.raw); // refused
  }

  @Get('reason')
  @Public(`templated ${TAG}`) // refused
  reason() {}

  @Public('property') // refused
  handler = () => [Maintenance, Catalogue, openly, shorthand, Open]; // refused
}

@Injectable()
export class Feed {
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost, // refused
    private readonly discovery: DiscoveryService, // refused
  ) {}

  open() {
    this.host.httpAdapter.get('/v1/feed', () => this.discovery); // refused
  }
}

export class FeedModule implements NestModule {
  // refused
  configure(consumer: MiddlewareConsumer) {
    // refused
    consumer.apply(() => undefined).forRoutes('{*path}'); // refused
  }
}
