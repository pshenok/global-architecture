import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import {
  actorFromClaims,
  currentActor,
  currentCaller,
  currentEvent,
  currentPrincipalToken,
  currentService,
  enterEventDelivery,
  enterVerifiedCall,
  serviceActorOf,
} from './principal-context.ts';

const USER = '01900000-0000-7000-8000-000000000001';
const EVENT = {
  id: '01900000-0000-7000-8000-0000000000e1',
  type: 'ga.house.v1.HouseDeletedEvent',
  producer: 'house-service',
  aggregateId: '01900000-0000-7000-8000-0000000000a1',
  occurredAt: new Date('2026-10-23T10:00:00Z'),
  attempt: 2,
};

const inContext = <T>(work: () => T): T => ClsServiceManager.getClsService().run(work);

describe('currentService', () => {
  it('is the calling workload of a service call', () => {
    inContext(() => {
      enterVerifiedCall(ClsServiceManager.getClsService(), {
        caller: 'house-service',
        actor: serviceActorOf('house-service'),
      });
      expect(currentService()).toEqual({ kind: 'service', name: 'house-service' });
      expect(currentEvent()).toBeUndefined();
    });
  });

  it('refuses users, identities and requests without an actor', () => {
    inContext(() => {
      enterVerifiedCall(ClsServiceManager.getClsService(), {
        caller: 'gateway',
        actor: actorFromClaims({ kind: 'user', userId: USER, roles: ['admin'] }),
        principalToken: 'principal',
      });
      expect(() => currentService()).toThrow(
        expect.objectContaining({ kind: 'UNAUTHENTICATED', reason: 'SERVICE_REQUIRED' }),
      );
    });
    inContext(() => expect(() => currentService()).toThrow(/requires a workload/));
    expect(() => currentService()).toThrow(/requires a workload/);
  });
});

describe('enterEventDelivery', () => {
  it('runs the delivery as the service itself, with nothing to forward', () => {
    inContext(() => {
      enterEventDelivery(ClsServiceManager.getClsService(), 'booking-service', EVENT);
      expect(currentService()).toEqual({ kind: 'service', name: 'booking-service' });
      expect(currentActor().kind).toBe('service');
      expect(currentEvent()).toEqual(EVENT);
      expect(Object.isFrozen(currentEvent())).toBe(true);
      expect(currentCaller()).toBeUndefined();
      expect(currentPrincipalToken()).toBeUndefined();
    });
    expect(currentEvent()).toBeUndefined();
  });
});
