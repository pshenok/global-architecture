import { EventsModule, GrpcPlatformModule } from '@ga/service-kit';
import { Module } from '@nestjs/common';
import { UserEvents } from './application/ports/user-events.ts';
import { UserService } from './application/user.service.ts';
import { ConfigSchema } from './config.ts';
import { UserRepository } from './domain/user.repository.ts';
import { OutboxUserEvents } from './infrastructure/events/outbox-user-events.ts';
import { DrizzleUserRepository } from './infrastructure/persistence/drizzle-user.repository.ts';
import { SERVICE } from './service.ts';
import { UserGrpcController } from './transport/grpc/user.grpc-controller.ts';

/** Composition root: the only place where ports are bound to adapters. */
@Module({
  imports: [
    GrpcPlatformModule.forRoot({ service: SERVICE, config: ConfigSchema }),
    EventsModule.forRoot({ publish: true }),
  ],
  controllers: [UserGrpcController],
  providers: [
    UserService,
    { provide: UserRepository, useClass: DrizzleUserRepository },
    { provide: UserEvents, useClass: OutboxUserEvents },
  ],
})
export class AppModule {}
