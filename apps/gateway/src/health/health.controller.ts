import { checkGrpcHealth, type DownstreamHealth, InjectConfig } from '@ga/service-kit';
import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import type { Config } from '../config.ts';

/**
 * /healthz: liveness (the process answers).
 * /readyz:  readiness (every downstream gRPC service reports SERVING via grpc.health.v1).
 */
@ApiExcludeController()
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(@InjectConfig() private readonly config: Config) {}

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
    void reply.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'degraded', dependencies };
  }
}
