import {
  installWellKnownTypes,
  loadProtoPackage,
  reflectionPackageDefinition,
} from '@ga/contracts/runtime';
import type { Server } from '@grpc/grpc-js';
import { ReflectionService } from '@grpc/reflection';
import type { INestMicroservice, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type GrpcOptions, Transport } from '@nestjs/microservices';
import type { TestingModule } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { grpcServiceConfigSchema, parseConfig } from '../config/config.ts';
import type { ServiceDefinition } from '../platform/service-definition.ts';
import { GrpcErrorFilter } from './grpc-error.filter.ts';
import { HealthStatus } from './health-status.ts';

export interface BootstrapGrpcOptions {
  /** Listen address override (tests). Defaults to GRPC_HOST:GRPC_PORT. */
  readonly url?: string;
  /** Install SIGTERM/SIGINT handlers (graceful shutdown). Default true; tests pass false. */
  readonly shutdownHooks?: boolean;
}

/** Builds the Nest gRPC transport options for a service: contracts, health, reflection, limits. */
export function grpcServerOptions(
  service: ServiceDefinition,
  url: string,
  maxMessageBytes: number,
  onServer: (server: Server) => void,
): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: {
      url,
      package: [...service.packages],
      packageDefinition: loadProtoPackage(service.protoFiles),
      onLoadPackageDefinition: (_pkg, server) => {
        onServer(server);
        new ReflectionService(reflectionPackageDefinition(), {
          services: [...service.services, 'grpc.health.v1.Health'],
        }).addToServer(server);
      },
      gracefulShutdown: true,
      maxReceiveMessageLength: maxMessageBytes,
      maxSendMessageLength: maxMessageBytes,
    },
  };
}

function isTestingModule(root: unknown): root is TestingModule {
  return typeof (root as TestingModule | undefined)?.createNestMicroservice === 'function';
}

/**
 * Starts a gRPC service: the only bootstrap code a service's main.ts needs.
 *
 * Installs proto well-known-type wrappers, serves the service's contracts plus
 * grpc.health.v1 and server reflection, routes Nest logs through pino, maps
 * errors with GrpcErrorFilter (always on), enables graceful shutdown, then
 * reports SERVING once dependency checks pass.
 */
export async function bootstrapGrpcService(
  root: Type<unknown> | TestingModule,
  service: ServiceDefinition,
  options: BootstrapGrpcOptions = {},
): Promise<INestMicroservice> {
  installWellKnownTypes();
  const env = parseConfig(grpcServiceConfigSchema);
  const url = options.url ?? `${env.GRPC_HOST}:${env.GRPC_PORT}`;

  let health: HealthStatus | undefined;
  const transport = grpcServerOptions(service, url, env.GRPC_MAX_MESSAGE_BYTES, (server) => {
    if (!health) throw new Error('HealthStatus not resolved before the gRPC server started');
    health.implementation.addToServer(server);
  });

  const app = isTestingModule(root)
    ? root.createNestMicroservice<GrpcOptions>({ ...transport, bufferLogs: true })
    : await NestFactory.createMicroservice<GrpcOptions>(root, { ...transport, bufferLogs: true });

  app.useLogger(app.get(Logger));
  const healthStatus = app.get(HealthStatus);
  health = healthStatus;
  // Filters must be registered before listen(): gRPC handlers bind at listen time.
  app.useGlobalFilters(new GrpcErrorFilter(service.name));
  if (options.shutdownHooks ?? true) app.enableShutdownHooks();

  await app.listen();
  await healthStatus.start();
  app.get(Logger).log(`${service.name} listening on ${url} (${service.services.join(', ')})`);
  return app;
}
