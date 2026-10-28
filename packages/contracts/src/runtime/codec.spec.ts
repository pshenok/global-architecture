import { describe, expect, it } from 'vitest';
import type { HouseDeletedEvent } from '../gen/ga/house/v1/house_events.ts';
import { messageCodec } from './codec.ts';

/** Runs first in its file, so the codec is this process's first protobufjs user. */
describe('messageCodec', () => {
  it('round-trips Date through google.protobuf.Timestamp, like an RPC', () => {
    const codec = messageCodec('ga/house/v1/house.proto', 'ga.house.v1.House');
    const created = new Date('2026-10-23T10:11:12.345Z');
    const decoded = codec.decode(codec.encode({ id: 'h1', createTime: created }));
    expect(decoded.createTime).toEqual(created);
    expect(decoded.updateTime).toBeNull();
    expect(decoded.maxGuests).toBe(0);
  });

  it('round-trips an event payload with camelCase keys and scalar defaults', () => {
    const codec = messageCodec('ga/house/v1/house_events.proto', 'ga.house.v1.HouseDeletedEvent');
    const payload: HouseDeletedEvent = { houseId: 'h1', ownerId: 'u1' };
    expect(codec.type).toBe('ga.house.v1.HouseDeletedEvent');
    expect(codec.decode(codec.encode(payload))).toEqual({
      houseId: 'h1',
      ownerId: 'u1',
    });
    expect(codec.decode(new Uint8Array())).toEqual({ houseId: '', ownerId: '' });
    expect(messageCodec('ga/house/v1/house_events.proto', 'ga.house.v1.HouseDeletedEvent')).toBe(
      codec,
    );
  });

  it('refuses bytes that are not an encoding', () => {
    const codec = messageCodec('ga/house/v1/house_events.proto', 'ga.house.v1.HouseDeletedEvent');
    expect(() => codec.decode(Uint8Array.of(0x0a, 0x10, 0x61))).toThrow();
  });

  it('fails at once on an unknown file or message', () => {
    expect(() => messageCodec('ga/house/v1/nope.proto', 'ga.house.v1.Nope')).toThrow();
    expect(() =>
      messageCodec('ga/house/v1/house_events.proto', 'ga.house.v1.HouseRenamedEvent'),
    ).toThrow(/HouseRenamedEvent/);
  });
});
