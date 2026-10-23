import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestWorkloadKeys, type TestWorkloadKeys } from '../testing/workload-keys.ts';
import type { WorkloadIdentityConfig } from './config.ts';
import { WorkloadIdentity } from './workload-identity.ts';
import { MAX_KEYS_PER_WORKLOAD, parseWorkloadKeyMap } from './workload-keys.ts';

const key = (kid: string, extra: Record<string, unknown> = {}) => ({
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'A'.repeat(43),
  kid,
  alg: 'EdDSA',
  ...extra,
});
const mapOf = (keys: unknown[]) => JSON.stringify({ workloads: { gateway: { keys } } });

describe('workload key map', () => {
  it('accepts public Ed25519 keys', () => {
    expect(parseWorkloadKeyMap(mapOf([key('a'), key('b')]), 'test').get('gateway')).toHaveLength(2);
  });

  it.each([
    ['private key material', mapOf([key('a', { d: 'B'.repeat(43) })]), /private key material/],
    ['a duplicate kid', mapOf([key('a'), key('a')]), /duplicate kids/],
    [
      'too many keys',
      mapOf(Array.from({ length: MAX_KEYS_PER_WORKLOAD + 1 }, (_, i) => key(`k${i}`))),
      /invalid/,
    ],
    ['a non-Ed25519 key', mapOf([key('a', { crv: 'X25519' })]), /invalid/],
    ['alg "Ed25519" (jose would never match it)', mapOf([key('a', { alg: 'Ed25519' })]), /invalid/],
    ['a missing kid', mapOf([{ kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) }]), /invalid/],
    [
      'a non-kebab workload name',
      JSON.stringify({ workloads: { Gateway: { keys: [key('a')] } } }),
      /invalid/,
    ],
    ['broken JSON', '{', /not valid JSON/],
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseWorkloadKeyMap(text, 'test')).toThrow(message);
  });
});

describe('WorkloadIdentity', () => {
  let keys: TestWorkloadKeys;
  const config = (name: string): WorkloadIdentityConfig => ({
    ...keys.env(name),
    WORKLOAD_KEYS_RELOAD_S: 3600,
    PRINCIPAL_ISSUERS: ['gateway'],
  });

  beforeAll(async () => {
    keys = await createTestWorkloadKeys(['gateway', 'house-service', 'user-service']);
  });
  afterAll(() => keys.dispose());

  it('signs caller assertions the target accepts, and caches them', async () => {
    const house = await WorkloadIdentity.load('house-service', config('house-service'));
    const user = await WorkloadIdentity.load('user-service', config('user-service'));
    const token = await house.callerToken('user-service');
    expect(await house.callerToken('user-service')).toBe(token);
    await expect(user.verifyCaller(token)).resolves.toBe('house-service');
    house.onApplicationShutdown();
    user.onApplicationShutdown();
  });

  it('lets only edges sign principals', async () => {
    const house = await WorkloadIdentity.load('house-service', config('house-service'));
    expect(() =>
      house.signPrincipal(
        { kind: 'user', userId: '01900000-0000-7000-8000-000000000001', roles: [] },
        60,
      ),
    ).toThrow(/PRINCIPAL_ISSUERS/);
    house.onApplicationShutdown();
  });

  it('refuses to boot when its own public key is not published', async () => {
    const other = await createTestWorkloadKeys(['house-service']);
    try {
      await expect(
        WorkloadIdentity.load('house-service', {
          ...config('house-service'),
          WORKLOAD_KEY_FILE: other.keyFile('house-service'),
        }),
      ).rejects.toThrow(/has no public key/);
    } finally {
      other.dispose();
    }
  });

  it('keeps the last good key map when a reload fails, and applies the next valid one', async () => {
    const reloading = await createTestWorkloadKeys(['gateway', 'house-service']);
    try {
      const house = await WorkloadIdentity.load('house-service', {
        ...config('house-service'),
        ...reloading.env('house-service'),
      });
      const gateway = await WorkloadIdentity.load('gateway', {
        ...config('gateway'),
        ...reloading.env('gateway'),
      });
      const token = await gateway.callerToken('house-service');
      const good = JSON.parse(readFileSync(reloading.keysFile, 'utf8')) as {
        workloads: Record<string, unknown>;
      };
      for (const broken of ['{ broken', JSON.stringify({ workloads: { gateway: { keys: [] } } })]) {
        writeFileSync(reloading.keysFile, broken);
        house.reload();
        await expect(house.verifyCaller(token)).resolves.toBe('gateway');
      }
      delete good.workloads.gateway;
      writeFileSync(reloading.keysFile, JSON.stringify(good));
      house.reload();
      await expect(house.verifyCaller(token)).rejects.toMatchObject({ reason: 'invalid' });
      house.onApplicationShutdown();
      gateway.onApplicationShutdown();
    } finally {
      reloading.dispose();
    }
  });
});
