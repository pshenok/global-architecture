import { type Database, DRIZZLE, GrpcPlatformModule } from '@ga/service-kit';
import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { EventBusService } from './application/event-bus.service.ts';
import { EventBroker } from './application/ports/event-broker.ts';
import { EventBrokerAdmin } from './application/ports/event-broker-admin.ts';
import { ConfigSchema } from './config.ts';
import { subscriptions } from './domain/topics.ts';
import { PostgresEventBroker } from './infrastructure/persistence/postgres-event-broker.ts';
import { PostgresEventBrokerAdmin } from './infrastructure/persistence/postgres-event-broker-admin.ts';
import { EventRetention } from './infrastructure/retention.ts';
import { SERVICE } from './service.ts';
import { EventBusGrpcController } from './transport/grpc/event-bus.grpc-controller.ts';

/**
 * Composition root: the only place where ports are bound to adapters (the CLI builds its
 * own EventBrokerAdmin). The bus has no gRPC clients: it calls no service (ADR-0005),
 * which check-call-graph enforces.
 */
@Module({
  imports: [GrpcPlatformModule.forRoot({ service: SERVICE, config: ConfigSchema })],
  controllers: [EventBusGrpcController],
  providers: [
    EventBusService,
    { provide: EventBroker, useClass: PostgresEventBroker },
    // A factory: the adapter carries no Nest decorators, so the CLI can load it unbuilt.
    {
      provide: EventBrokerAdmin,
      inject: [DRIZZLE],
      useFactory: (db: Database) => new PostgresEventBrokerAdmin(db),
    },
    EventRetention,
  ],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(private readonly broker: EventBroker) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.broker.provision(subscriptions());
  }
}
