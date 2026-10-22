import { installWellKnownTypes } from '@ga/contracts/runtime';
import { parseConfig } from '@ga/service-kit';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.ts';
import { configureGateway, createAdapter } from './bootstrap.ts';
import { ConfigSchema } from './config.ts';

installWellKnownTypes();
const config = parseConfig(ConfigSchema);
const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(config), {
  bufferLogs: true,
});
configureGateway(app, config);
await app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT });
const scheme = config.TLS_ENABLED ? 'https' : 'http';
app
  .get(Logger)
  .log(
    `gateway listening on ${scheme}://${config.GATEWAY_HOST}:${config.GATEWAY_PORT} (docs: /docs)`,
  );
