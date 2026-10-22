import { GrpcPlatformModule } from '@ga/service-kit';
import { Module } from '@nestjs/common';
import { BookingService } from './application/booking.service.ts';
import { HouseCatalog } from './application/ports/house-catalog.ts';
import { UserDirectory } from './application/ports/user-directory.ts';
import { ConfigSchema } from './config.ts';
import { BookingRepository } from './domain/booking.repository.ts';
import { GrpcHouseCatalog } from './infrastructure/clients/grpc-house-catalog.ts';
import { GrpcUserDirectory } from './infrastructure/clients/grpc-user-directory.ts';
import { HouseServiceClientModule } from './infrastructure/clients/house-service.client.ts';
import { UserServiceClientModule } from './infrastructure/clients/user-service.client.ts';
import { DrizzleBookingRepository } from './infrastructure/persistence/drizzle-booking.repository.ts';
import { SERVICE } from './service.ts';
import { BookingGrpcController } from './transport/grpc/booking.grpc-controller.ts';

/** Composition root: the only place where ports are bound to adapters. */
@Module({
  imports: [
    GrpcPlatformModule.forRoot({ service: SERVICE, config: ConfigSchema }),
    UserServiceClientModule,
    HouseServiceClientModule,
  ],
  controllers: [BookingGrpcController],
  providers: [
    BookingService,
    { provide: BookingRepository, useClass: DrizzleBookingRepository },
    { provide: UserDirectory, useClass: GrpcUserDirectory },
    { provide: HouseCatalog, useClass: GrpcHouseCatalog },
  ],
})
export class AppModule {}
