/**
 * Self-test of tools/check-call-graph.ts, read like clients.ts and with its marks: ways to
 * take a client builder from a whole module, where no name is left to resolve. In an app
 * every namespace import, `export *` and `import()` is refused (of a harmless module too),
 * and so is a default or named import that is all of grpc-js, or an import of another
 * app's file without names; the reads that follow are what the refusals prevent, so they
 * carry no mark. Nothing imports or runs this file.
 */
// biome-ignore-all lint/performance/noDynamicNamespaceImportAccess: the probes read by key on purpose
import '../../../booking-service/src/infrastructure/clients/house-service.client.ts'; // refused
import * as kernel from '@ga/kernel'; // refused
import * as kit from '@ga/service-kit'; // refused
import {
  type GrpcClientDefinition,
  outboundContextInterceptor,
  type WorkloadIdentity,
} from '@ga/service-kit';
import * as grpc from '@grpc/grpc-js'; // refused
import { default as grpcModule } from '@grpc/grpc-js'; // refused
import type { DynamicModule } from '@nestjs/common';
import * as microservices from '@nestjs/microservices'; // refused
import { z } from 'zod';
import * as borrowed from './reexport.ts'; // refused

const T = Symbol('BOOKING_SERVICE');
const S = 'ga.booking.v1.BookingService';
const P = ['ga/booking/v1/booking.proto'];
const U = () => 'localhost:50053';

// The kit as a namespace: the builder read by key, destructured, passed or typed away.
const NAME = 'GrpcClientsModule';
const METHOD = 'register';
interface Register {
  register(definitions: readonly GrpcClientDefinition[]): DynamicModule;
}
export const byKey = kit[NAME][METHOD]([
  { token: T, service: S, target: 'booking-service', protoFiles: P, url: U },
]);
export const { [NAME]: Destructured } = kit;
const registerWith = (clients: Register) =>
  clients.register([{ token: T, service: S, target: 'booking-service', protoFiles: P, url: U }]);
export const passed = registerWith(kit[NAME]);
const fromNamespace = (namespace: { readonly GrpcClientsModule: Register }) =>
  namespace.GrpcClientsModule.register([
    { token: T, service: S, target: 'booking-service', protoFiles: P, url: U },
  ]);
export const passedNamespace = fromNamespace(kit);
export const typed: Register = kit[NAME];
export const dotted = kit.GrpcClientsModule.register([
  { token: T, service: S, target: 'booking-service', protoFiles: P, url: U }, // edge: booking-service
]);
export const lazyKit = import('@ga/service-kit'); // refused
export const kernelNamespace = kernel;
export const lazyKernel = import('@ga/kernel'); // refused

// Raw clients through Nest's and grpc-js's namespaces, signed with the kit's interceptor.
const FACTORY = 'ClientProxyFactory';
const LOAD = 'loadPackageDefinition';
export const nest = (identity: WorkloadIdentity) =>
  microservices[FACTORY].create({
    transport: microservices.Transport.GRPC,
    options: {
      package: 'ga.house.v1',
      protoPath: 'ga/house/v1/house.proto',
      channelOptions: {
        interceptors: [outboundContextInterceptor(3000, 'house-service', identity)],
      },
    },
  });
export const grpcByKey = grpc[LOAD]({});
export const grpcDefault = grpcModule[LOAD]({});

// Another app's client module, through a file that re-exports it whole.
const BORROWED = 'HouseServiceClientModule';
export const borrowedModule = borrowed[BORROWED];

// Legal: a named import that is a whole module, when it cannot build a client.
export const schema = z.string();
