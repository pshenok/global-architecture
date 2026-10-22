import { Clock, IdGenerator, UnitOfWork } from '@ga/kernel';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import type { z } from 'zod';
import { CONFIG, ConfigModule, type GrpcServiceConfig } from '../config/config.ts';
import { requestIdFromRpc } from '../context/request-context.ts';
import { DatabaseModule } from '../database/database.module.ts';
import { DbContext, DrizzleUnitOfWork } from '../database/db-context.ts';
import { DRIZZLE } from '../database/tokens.ts';
import { HealthStatus } from '../grpc/health-status.ts';
import { grpcLoggerParams } from '../logging/logger-params.ts';
import { SystemClock, UuidV7IdGenerator } from './core-providers.ts';
import { SERVICE_DEFINITION, type ServiceDefinition } from './service-definition.ts';

export interface GrpcPlatformOptions {
  readonly service: ServiceDefinition;
  /** The service's config schema; must extend grpcServiceConfigSchema (and databaseConfigSchema when database is on). */
  readonly config: z.ZodType<GrpcServiceConfig>;
  /** Owns a Postgres database (pool, Drizzle, UnitOfWork, DbContext, health check). Default true. */
  readonly database?: boolean;
}

/**
 * Everything a gRPC service needs, in one import:
 * config, structured logging, request context, health, ids, clock and
 * (optionally) the database with transactions.
 *
 *   @Module({ imports: [GrpcPlatformModule.forRoot({ service: SERVICE, config: ConfigSchema })], ... })
 */
@Module({})
export class GrpcPlatformModule {
  static forRoot(options: GrpcPlatformOptions): DynamicModule {
    const database = options.database ?? true;
    const providers: Provider[] = [
      { provide: SERVICE_DEFINITION, useValue: options.service },
      HealthStatus,
      { provide: IdGenerator, useClass: UuidV7IdGenerator },
      { provide: Clock, useClass: SystemClock },
    ];
    if (database) {
      providers.push(DbContext, { provide: UnitOfWork, useClass: DrizzleUnitOfWork });
    }
    return {
      module: GrpcPlatformModule,
      global: true,
      imports: [
        ConfigModule.forRoot(options.config),
        LoggerModule.forRootAsync({
          inject: [CONFIG],
          useFactory: (config: GrpcServiceConfig) => grpcLoggerParams(options.service.name, config),
        }),
        ClsModule.forRoot({
          global: true,
          interceptor: { mount: true, generateId: true, idGenerator: requestIdFromRpc },
          plugins: database
            ? [
                new ClsPluginTransactional({
                  imports: [DatabaseModule],
                  adapter: new TransactionalAdapterDrizzleOrm({ drizzleInstanceToken: DRIZZLE }),
                }),
              ]
            : [],
        }),
        ...(database ? [DatabaseModule] : []),
      ],
      providers,
      exports: [
        SERVICE_DEFINITION,
        HealthStatus,
        IdGenerator,
        Clock,
        ...(database ? [DbContext, UnitOfWork] : []),
      ],
    };
  }
}
