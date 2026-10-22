import { bootstrapGrpcService } from '@ga/service-kit';
import { AppModule } from './app.module.ts';
import { SERVICE } from './service.ts';

await bootstrapGrpcService(AppModule, SERVICE);
