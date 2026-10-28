/**
 * Self-test of tools/check-call-graph.ts, which reads this folder as if it were a package's
 * production code (packages/call-graph-probes/src), with the marks of ../clients.ts. Outside
 * apps a module may be bound whole (namespace import, `export *`, `import()`, a CommonJS
 * default), unless it is the kit, @nestjs/microservices, @grpc/grpc-js or an app's code, or
 * exports a client builder or an app's code. Nothing imports or runs this file.
 */

import * as kernel from '@ga/kernel';
import * as kit from '@ga/service-kit'; // refused
import * as testing from '@ga/service-kit/testing'; // refused
import grpcModule from '@grpc/grpc-js'; // refused
import * as local from './kit.ts'; // refused

export * from '@ga/kernel';
export * as microservices from '@nestjs/microservices'; // refused
export * from '../definitions.ts'; // refused
export * from './kit.ts'; // refused

export const namespaces = [grpcModule, kernel, kit, testing, local];
export const lazyKernel = import('@ga/kernel');
export const lazyGrpc = import('@grpc/grpc-js'); // refused
export const lazyApp = import('../clients.ts'); // refused
const SPECIFIER = '@ga/kernel';
export const computed = import(SPECIFIER); // refused
