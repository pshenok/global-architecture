import { checkGrpcHealth, type DownstreamHealth, InjectConfig } from '@ga/service-kit';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { IDP_KEY_SETS } from '../auth/auth.module.ts';
import { Public } from '../auth/decorators.ts';
import type { IdpKeySet, KeySetState } from '../auth/idp-key-set.ts';
import type { Config } from '../config.ts';

const WORST: readonly KeySetState[] = ['unavailable', 'stale', 'ok'];

/**
 * /healthz: liveness (the process answers).
 * /readyz:  readiness (every downstream gRPC service reports SERVING via grpc.health.v1).
 *           `identityProvider` is informational: an IdP outage must not take the
 *           gateway out of rotation, because public routes and cached keys still work.
 */
@ApiExcludeController()
@SkipThrottle()
@Public('liveness and readiness probes')
@Controller()
export class HealthController {
  constructor(
    @InjectConfig() private readonly config: Config,
    @Inject(IDP_KEY_SETS) private readonly keySets: ReadonlyMap<string, IdpKeySet>,
  ) {}

  @Get('healthz')
  live() {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const targets: Record<string, string> = {
      'user-service': this.config.USER_SERVICE_URL,
      'house-service': this.config.HOUSE_SERVICE_URL,
      'booking-service': this.config.BOOKING_SERVICE_URL,
    };
    const entries = await Promise.all(
      Object.entries(targets).map(
        async ([name, url]) =>
          [name, await checkGrpcHealth(url, { caFile: this.config.GRPC_TLS_CA_FILE })] as const,
      ),
    );
    const dependencies: Record<string, DownstreamHealth> = Object.fromEntries(entries);
    const ready = entries.every(([, status]) => status === 'SERVING');
    const states = [...this.keySets.values()].map((keySet) => keySet.state);
    const identityProvider = WORST.find((state) => states.includes(state)) ?? 'ok';
    void reply.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'degraded', dependencies, identityProvider };
  }
}
