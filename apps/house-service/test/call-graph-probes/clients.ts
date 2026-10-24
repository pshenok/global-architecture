/**
 * Self-test of tools/check-call-graph.ts, which reads this file as if it were production
 * code in house-service: every line marked `refused` must be refused and no other line,
 * and every line marked `edge: <workload>` must yield exactly that edge and no other line
 * any. Each probe is a way to hide a call from the graph that a review found, or a legal
 * spelling the graph must still read. Nothing imports or runs this file.
 */

import * as kit from '@ga/service-kit';
import {
  EventsModule as Bus,
  GrpcClientsModule as Clients,
  GrpcClientsModule,
} from '@ga/service-kit';
import { Client, credentials, makeGenericClientConstructor } from '@grpc/grpc-js'; // refused
import { ClientProxyFactory, Transport } from '@nestjs/microservices'; // refused
import { BOOKING_DEFINITION, DEFINITIONS } from './definitions.ts';

const T = Symbol('BOOKING_SERVICE');
const S = 'ga.booking.v1.BookingService';
const P = ['ga/booking/v1/booking.proto'];
const U = () => 'localhost:50053';

// Legal: an inline literal target is an edge, however the module is named.
export const plain = GrpcClientsModule.register([
  { token: T, service: S, target: 'booking-service', protoFiles: P, url: U }, // edge: booking-service
]);
export const aliased = Clients.register([
  { token: T, service: S, target: 'booking-service', protoFiles: P, url: U }, // edge: booking-service
]);
export const viaNamespace = kit.GrpcClientsModule.register([
  { token: T, service: S, target: 'booking-service', protoFiles: P, url: U }, // edge: booking-service
]);
// biome-ignore format: a `//` inside a string before the target, on one line
export const urlFirst = GrpcClientsModule.register([{ token: T, service: S, url: () => 'dns:///booking-service:50053', target: 'booking-service', protoFiles: P }]); // edge: booking-service
export const events = Bus.forRoot({ publish: true }); // edge: event-bus-service

// Targets the graph cannot read.
const target = 'booking-service';
const TARGET = 'booking-service';
const KEY = 'target';
export const shorthand = GrpcClientsModule.register([
  { token: T, service: S, target, protoFiles: P, url: U }, // refused
]);
export const forTarget = (target: string) =>
  GrpcClientsModule.register([{ token: T, service: S, target, protoFiles: P, url: U }]); // refused
export const constant = GrpcClientsModule.register([
  { token: T, service: S, target: TARGET, protoFiles: P, url: U }, // refused
]);
export const unknown = GrpcClientsModule.register([
  { token: T, service: S, target: 'billing-service', protoFiles: P, url: U }, // refused
]);
export const computed = GrpcClientsModule.register([
  { token: T, service: S, [KEY]: 'booking-service', protoFiles: P, url: U }, // refused
]);
export const getter = GrpcClientsModule.register([
  {
    token: T,
    service: S,
    get target() {
      // refused
      return 'house-service';
    },
    protoFiles: P,
    url: U,
  },
]);
export const elsewhere = GrpcClientsModule.register(DEFINITIONS); // refused
export const spread = GrpcClientsModule.register([...DEFINITIONS]); // refused
export const spreadProperty = GrpcClientsModule.register([
  { ...BOOKING_DEFINITION, target: 'house-service' }, // refused
]);

// register and GrpcClientsModule used as values.
const REGISTER = 'register';
export const registerFn = GrpcClientsModule.register; // refused
export const { register: destructured } = GrpcClientsModule; // refused
export const byKey = GrpcClientsModule[REGISTER](DEFINITIONS); // refused
export const viaCall = GrpcClientsModule.register.call(null, DEFINITIONS); // refused
const Alias = GrpcClientsModule; // refused
export const viaVariable = Alias.register([
  { token: T, service: S, target: 'booking-service', protoFiles: P, url: U }, // edge: booking-service
]);

// Clients built without the kit.
const GRPC = { package: 'ga.booking.v1' };
export const nest = ClientProxyFactory.create({ transport: Transport.GRPC, options: GRPC }); // refused
export const raw = new Client('localhost:50053', credentials.createInsecure()); // refused
export const generic = makeGenericClientConstructor({}, 'BookingService'); // refused

// Another app's client module, counted for that app.
export { HouseServiceClientModule } from '../../../booking-service/src/infrastructure/clients/house-service.client.ts'; // refused
