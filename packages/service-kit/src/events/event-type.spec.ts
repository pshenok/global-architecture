import { describe, expect, it } from 'vitest';
import { defineEvent } from './event-type.ts';

describe('defineEvent', () => {
  it('derives the contract file from the type name', () => {
    expect(defineEvent('ga.house.v1.HouseDeletedEvent', { producer: 'house-service' })).toEqual({
      type: 'ga.house.v1.HouseDeletedEvent',
      producer: 'house-service',
      protoFile: 'ga/house/v1/house_events.proto',
    });
  });

  it('refuses names off the convention, bad producers and missing payloads', () => {
    for (const type of [
      'house.Deleted',
      'ga.house.v1.HouseDeleted',
      'ga.House.v1.XEvent',
      'ga.house.HouseDeletedEvent',
    ]) {
      expect(() => defineEvent(type, { producer: 'house-service' })).toThrow(/not ga\./);
    }
    expect(() => defineEvent('ga.house.v1.HouseDeletedEvent', { producer: 'House' })).toThrow(
      /not a workload/,
    );
    expect(() =>
      defineEvent('ga.house.v1.HouseRenamedEvent', { producer: 'house-service' }),
    ).toThrow(/HouseRenamedEvent/);
    expect(() =>
      defineEvent('ga.payment.v1.PaymentMadeEvent', { producer: 'payment-service' }),
    ).toThrow();
  });
});
