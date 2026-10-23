import { CONFIG, ConfigModule, httpLoggerParams, WorkloadIdentityModule } from '@ga/service-kit';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { AuthGuard } from './auth/auth.guard.ts';
import { AuthModule } from './auth/auth.module.ts';
import { BookingsController } from './bookings/bookings.controller.ts';
import { DownstreamClientsModule } from './clients.ts';
import { type Config, ConfigSchema } from './config.ts';
import { HealthController } from './health/health.controller.ts';
import { HousesController } from './houses/houses.controller.ts';
import { UsersController } from './users/users.controller.ts';

@Module({
  imports: [
    ConfigModule.forRoot(ConfigSchema),
    // The gateway's own key: signs caller assertions to the services (ADR-0004).
    WorkloadIdentityModule.forRoot({ name: 'gateway' }),
    LoggerModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: Config) => httpLoggerParams('gateway', config),
    }),
    // Request context: the Fastify request id becomes the CLS id, which the gRPC
    // clients forward as x-request-id to every downstream call.
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (request: { id?: unknown }) => String(request.id),
      },
    }),
    ThrottlerModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: Config) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: config.RATE_LIMIT_PER_MINUTE }],
      }),
    }),
    DownstreamClientsModule,
    AuthModule,
  ],
  controllers: [HealthController, UsersController, HousesController, BookingsController],
  // Order matters: rate limiting runs before any token cryptography.
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
