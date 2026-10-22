import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { CONFIG, type DatabaseConfig } from '../config/config.ts';
import { HealthStatus } from '../grpc/health-status.ts';
import { SERVICE_DEFINITION, type ServiceDefinition } from '../platform/service-definition.ts';
import { DRIZZLE, PG_POOL } from './tokens.ts';

export function createPool(config: DatabaseConfig, applicationName: string): pg.Pool {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: applicationName,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: config.DB_STATEMENT_TIMEOUT_MS * 2,
  });
}

/**
 * One pg Pool and one Drizzle instance per process. Registers a `select 1`
 * health check and closes the pool after the gRPC server has drained.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [CONFIG, SERVICE_DEFINITION],
      useFactory: (config: DatabaseConfig, service: ServiceDefinition) => {
        const pool = createPool(config, service.name);
        const logger = new Logger('PgPool');
        // An idle client error is emitted on the pool; unhandled it would crash the process.
        pool.on('error', (error) => logger.error(`idle client error: ${error.message}`));
        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => drizzle({ client: pool }),
    },
  ],
  exports: [PG_POOL, DRIZZLE],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly health: HealthStatus,
  ) {}

  onModuleInit(): void {
    this.health.registerCheck('postgres', () => this.pool.query('select 1'));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
