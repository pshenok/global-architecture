import type * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestWorkloadKeys, type TestWorkloadKeys } from '../testing/workload-keys.ts';
import { signCallerToken } from './tokens.ts';
import { WorkloadIdentity } from './workload-identity.ts';
import { parseSigningKey } from './workload-keys.ts';

/** Lets a test replace a file on disk right after the next read of it returns. */
const race = vi.hoisted(() => ({ file: '', next: undefined as string | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    readFileSync: (path: fs.PathOrFileDescriptor, options?: unknown) => {
      const text = real.readFileSync(path, options as BufferEncoding);
      if (path === race.file && race.next !== undefined) {
        real.writeFileSync(race.file, race.next);
        race.next = undefined;
      }
      return text;
    },
  };
});

describe('WorkloadIdentity.load', () => {
  let keys: TestWorkloadKeys;

  beforeAll(async () => {
    keys = await createTestWorkloadKeys(['gateway', 'house-service']);
  });
  afterAll(() => keys.dispose());

  it('applies a key map that changed while it was loading', async () => {
    // Rotation step 1 for house-service lands right after the gateway read the map.
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
    const pub = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(pub);
    const map = JSON.parse(readFileSync(keys.keysFile, 'utf8')) as {
      workloads: Record<string, { keys: object[] }>;
    };
    map.workloads['house-service']?.keys.push({ ...pub, kid, alg: 'EdDSA' });
    race.file = keys.keysFile;
    race.next = JSON.stringify(map);

    const gateway = await WorkloadIdentity.load('gateway', {
      ...keys.env('gateway'),
      WORKLOAD_KEYS_RELOAD_S: 3600,
      PRINCIPAL_ISSUERS: ['gateway'],
    });
    expect(race.next).toBeUndefined();
    await gateway.reload();
    const rotated = await parseSigningKey(
      JSON.stringify({ ...(await exportJWK(privateKey)), kid, alg: 'EdDSA' }),
      'rotated',
    );
    const token = await signCallerToken(rotated, 'house-service', 'gateway');
    await expect(gateway.verifyCaller(token)).resolves.toBe('house-service');
    gateway.onApplicationShutdown();
  });
});
