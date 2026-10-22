import { GrpcPlatformModule } from '@ga/service-kit';
import { Module } from '@nestjs/common';
import { UserService } from './application/user.service.ts';
import { ConfigSchema } from './config.ts';
import { UserRepository } from './domain/user.repository.ts';
import { DrizzleUserRepository } from './infrastructure/persistence/drizzle-user.repository.ts';
import { SERVICE } from './service.ts';
import { UserGrpcController } from './transport/grpc/user.grpc-controller.ts';

/** Composition root: the only place where ports are bound to adapters. */
@Module({
  imports: [GrpcPlatformModule.forRoot({ service: SERVICE, config: ConfigSchema })],
  controllers: [UserGrpcController],
  providers: [UserService, { provide: UserRepository, useClass: DrizzleUserRepository }],
})
export class AppModule {}
