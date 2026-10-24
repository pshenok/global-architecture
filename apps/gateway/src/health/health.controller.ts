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
 * /readyz:  readiness of the gateway itself. 503 until every service has answered SERVING
 *           once since this process started (a rollout with a wrong service URL or CA never
 *           becomes ready, so it cannot replace working replicas), and while the gateway
 *           shuts down (Fastify answers 503 to new requests on close). After that, the
 *           services' health and `identityProvider` are only reported, with `status:
 *           "degraded"` when one is not well: every replica sees the same services and IdP,
 *           so failing readiness on them would take the whole API out of rotation when one
 *           service is down, while that service's routes already fail on their own.
 */
@ApiExcludeController()
@SkipThrottle()
@Public('liveness and readiness probes', { ignoreToken: true })
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

  /** Services that answered SERVING at least once since this process started. */
  private readonly seenServing = new Set<string>();

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
    for (const [name, status] of entries) if (status === 'SERVING') this.seenServing.add(name);
    const dependencies: Record<string, DownstreamHealth> = Object.fromEntries(entries);
    const started = entries.every(([name]) => this.seenServing.has(name));
    const serving = entries.every(([, status]) => status === 'SERVING');
    const states = [...this.keySets.values()].map((keySet) => keySet.state);
    const identityProvider = WORST.find((state) => states.includes(state)) ?? 'ok';
    const status = !started ? 'starting' : serving && identityProvider === 'ok' ? 'ok' : 'degraded';
    void reply.status(started ? 200 : 503);
    return { status, dependencies, identityProvider };
  }
}
