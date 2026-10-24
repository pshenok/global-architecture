/**
 * Another app's client module re-exported whole, for modules.ts, which binds this file
 * whole in turn: no name is left for the checker to resolve. In an app even a harmless
 * module is not re-exported whole. Same marks as clients.ts.
 */
export * from '@ga/kernel'; // refused
export * from '../../../booking-service/src/infrastructure/clients/house-service.client.ts'; // refused
export * as booking from '../../../booking-service/src/infrastructure/clients/house-service.client.ts'; // refused
