import { GrpcPlatformModule } from '@ga/service-kit';
import { Module } from '@nestjs/common';
import { HouseService } from './application/house.service.ts';
import { UserDirectory } from './application/ports/user-directory.ts';
import { ConfigSchema } from './config.ts';
import { HouseRepository } from './domain/house.repository.ts';
import { GrpcUserDirectory } from './infrastructure/clients/grpc-user-directory.ts';
import { UserServiceClientModule } from './infrastructure/clients/user-service.client.ts';
import { DrizzleHouseRepository } from './infrastructure/persistence/drizzle-house.repository.ts';
import { SERVICE } from './service.ts';
import { HouseGrpcController } from './transport/grpc/house.grpc-controller.ts';

/** Composition root: the only place where ports are bound to adapters. */
@Module({
  imports: [
    GrpcPlatformModule.forRoot({ service: SERVICE, config: ConfigSchema }),
    UserServiceClientModule,
  ],
  controllers: [HouseGrpcController],
  providers: [
    HouseService,
    { provide: HouseRepository, useClass: DrizzleHouseRepository },
    { provide: UserDirectory, useClass: GrpcUserDirectory },
  ],
})
export class AppModule {}
