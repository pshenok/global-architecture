import { GrpcPlatformModule } from '@ga/service-kit';
import { Module } from '@nestjs/common';
import { SampleItemService } from './application/sample-item.service.ts';
import { ConfigSchema } from './config.ts';
import { SampleItemRepository } from './domain/sample-item.repository.ts';
import { DrizzleSampleItemRepository } from './infrastructure/persistence/drizzle-sample-item.repository.ts';
import { SERVICE } from './service.ts';
import { SampleItemGrpcController } from './transport/grpc/sample-item.grpc-controller.ts';

/** Composition root: the only place where ports are bound to adapters. */
@Module({
  imports: [GrpcPlatformModule.forRoot({ service: SERVICE, config: ConfigSchema })],
  controllers: [SampleItemGrpcController],
  providers: [
    SampleItemService,
    { provide: SampleItemRepository, useClass: DrizzleSampleItemRepository },
  ],
})
export class AppModule {}
