import { readFileSync, writeFileSync } from 'node:fs';
import { calculateJwkThumbprint, decodeProtectedHeader, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestWorkloadKeys, type TestWorkloadKeys } from '../testing/workload-keys.ts';
import type { WorkloadIdentityConfig } from './config.ts';
import { enterPrincipal, type IssuedPrincipal } from './principal-context.ts';
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
    [
      'one key under two workloads',
      JSON.stringify({
        workloads: { gateway: { keys: [key('a')] }, 'house-service': { keys: [key('b')] } },
      }),
      /gateway and house-service publish the same key/,
    ],
    [
      'one kid under two workloads',
      JSON.stringify({
        workloads: {
          gateway: { keys: [key('a')] },
          'house-service': { keys: [key('a', { x: 'B'.repeat(43) })] },
        },
      }),
      /publish the same key/,
    ],
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
    await expect(
      house.issuePrincipal(
        { kind: 'user', userId: '01900000-0000-7000-8000-000000000001', roles: [] },
        60,
      ),
    ).rejects.toThrow(/PRINCIPAL_ISSUERS/);
    house.onApplicationShutdown();
  });

  it('enters only principals the identity issued, never a hand-made actor', () => {
    const forged = {
      token: 'x.y.z',
      actor: { kind: 'user', userId: '01900000-0000-7000-8000-000000000001', roles: ['admin'] },
    } as unknown as IssuedPrincipal;
    expect(() => enterPrincipal(forged)).toThrow(/issuePrincipal/);
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

  it('rotates a signing key without a restart, and only once the key is published', async () => {
    const rotating = await createTestWorkloadKeys(['gateway', 'house-service']);
    try {
      const house = await WorkloadIdentity.load('house-service', {
        ...config('house-service'),
        ...rotating.env('house-service'),
      });
      const gateway = await WorkloadIdentity.load('gateway', {
        ...config('gateway'),
        ...rotating.env('gateway'),
      });
      const oldKid = gateway.signingKid;
      const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
      const pub = await exportJWK(publicKey);
      const kid = await calculateJwkThumbprint(pub);
      const signedKid = async () =>
        decodeProtectedHeader(await gateway.callerToken('house-service')).kid;

      // Private key replaced before its public half is published: keep the old one.
      writeFileSync(
        rotating.keyFile('gateway'),
        JSON.stringify({ ...(await exportJWK(privateKey)), kid, alg: 'EdDSA' }),
      );
      await gateway.reload();
      expect(await signedKid()).toBe(oldKid);

      // Published: every workload trusts it, and the gateway switches on its next reload.
      const map = JSON.parse(readFileSync(rotating.keysFile, 'utf8')) as {
        workloads: Record<string, { keys: unknown[] }>;
      };
      map.workloads.gateway?.keys.push({ kty: 'OKP', crv: 'Ed25519', x: pub.x, kid, alg: 'EdDSA' });
      writeFileSync(rotating.keysFile, JSON.stringify(map));
      await house.reload();
      await gateway.reload();
      expect(await signedKid()).toBe(kid);
      await expect(house.verifyCaller(await gateway.callerToken('house-service'))).resolves.toBe(
        'gateway',
      );

      // Pruning the old key does not cut the gateway off.
      map.workloads.gateway = {
        keys: [{ kty: 'OKP', crv: 'Ed25519', x: pub.x, kid, alg: 'EdDSA' }],
      };
      writeFileSync(rotating.keysFile, JSON.stringify(map));
      await house.reload();
      await gateway.reload();
      await expect(house.verifyCaller(await gateway.callerToken('house-service'))).resolves.toBe(
        'gateway',
      );
      house.onApplicationShutdown();
      gateway.onApplicationShutdown();
    } finally {
      rotating.dispose();
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
        await house.reload();
        await expect(house.verifyCaller(token)).resolves.toBe('gateway');
      }
      delete good.workloads.gateway;
      writeFileSync(reloading.keysFile, JSON.stringify(good));
      await house.reload();
      await expect(house.verifyCaller(token)).rejects.toMatchObject({ reason: 'invalid' });
      house.onApplicationShutdown();
      gateway.onApplicationShutdown();
    } finally {
      reloading.dispose();
    }
  });
});
