import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CONFIG } from '../config/config.ts';
import { DbContext } from '../database/db-context.ts';
import { GrpcClientsModule } from '../grpc/grpc-clients.module.ts';
import { type EventsConfig, parsedEventsConfigSchema } from './config.ts';
import { EVENT_BUS_GRPC, EventBusClient, GrpcEventBusClient } from './event-bus.client.ts';
import { EventConsumer } from './event-consumer.ts';
import { Outbox } from './outbox.ts';
import { OutboxRelay } from './outbox-relay.ts';
import { assertEventTables } from './tables.ts';
import { EVENTS_CONFIG, EVENTS_OPTIONS } from './tokens.ts';

export interface EventsModuleOptions {
  /** Records events with Outbox and publishes them (needs the `outbox` table). */
  readonly publish?: boolean;
  /** Runs the @OnEvent handlers of this service (needs the `processed_events` table). */
  readonly consume?: boolean;
}

@Injectable()
class EventTablesCheck implements OnModuleInit {
  constructor(
    private readonly db: DbContext,
    @Inject(EVENTS_OPTIONS) private readonly options: EventsModuleOptions,
  ) {}

  onModuleInit(): Promise<void> {
    return assertEventTables(this.db.tx, {
      publish: this.options.publish === true,
      consume: this.options.consume === true,
    });
  }
}

/**
 * Asynchronous events through event-bus-service (ADR-0005), for a service with a
 * database. The service never sees the bus or a queue: it records events with
 * `Outbox.add` inside `UnitOfWork.run`, and handles them with `@OnEvent` methods.
 *
 *   EventsModule.forRoot({ publish: true, consume: true })
 *
 * The service's config schema spreads `...eventsConfigSchema.shape`, and its schema.ts
 * holds the event tables (the ga-database skill); boot fails otherwise.
 */
@Module({})
export class EventsModule {
  static forRoot(options: EventsModuleOptions): DynamicModule {
    if (!options.publish && !options.consume) {
      throw new TypeError('EventsModule.forRoot needs publish, consume or both');
    }
    const providers: Provider[] = [
      { provide: EVENTS_OPTIONS, useValue: Object.freeze({ ...options }) },
      {
        provide: EVENTS_CONFIG,
        inject: [CONFIG],
        useFactory: (config: Record<string, unknown>): EventsConfig => {
          const parsed = parsedEventsConfigSchema.safeParse(config);
          if (!parsed.success) {
            throw new Error(
              'EventsModule: the service config lacks the events variables; spread ...eventsConfigSchema.shape into its ConfigSchema',
            );
          }
          return parsed.data;
        },
      },
      { provide: EventBusClient, useClass: GrpcEventBusClient },
      EventTablesCheck,
    ];
    if (options.publish) providers.push(Outbox, OutboxRelay);
    if (options.consume) providers.push(EventConsumer);
    return {
      module: EventsModule,
      imports: [
        DiscoveryModule,
        GrpcClientsModule.register([
          {
            token: EVENT_BUS_GRPC,
            service: 'ga.event_bus.v1.EventBusService',
            target: 'event-bus-service',
            protoFiles: ['ga/event_bus/v1/event_bus.proto'],
            url: (config) => String(config.EVENT_BUS_SERVICE_URL),
            timeoutMs: 5_000,
          },
        ]),
      ],
      providers,
      exports: options.publish ? [Outbox] : [],
    };
  }
}
