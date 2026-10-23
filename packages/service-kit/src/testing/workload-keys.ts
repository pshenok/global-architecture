import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { SigningKey } from '../auth/workload-keys.ts';
import { readSigningKey } from '../auth/workload-keys.ts';

export interface TestWorkloadKeys {
  readonly dir: string;
  /** The public key map (WORKLOAD_KEYS_FILE). */
  readonly keysFile: string;
  /** Private key file of a workload (its WORKLOAD_KEY_FILE). */
  keyFile(name: string): string;
  signingKey(name: string): Promise<SigningKey>;
  /** Environment for a workload: WORKLOAD_KEY_FILE + WORKLOAD_KEYS_FILE. */
  env(name: string): { WORKLOAD_KEY_FILE: string; WORKLOAD_KEYS_FILE: string };
  dispose(): void;
}

/**
 * Ephemeral Ed25519 keys for the given workloads, written to a temp dir in the same
 * format `pnpm keys` uses. Every workload trusts every other one.
 */
export async function createTestWorkloadKeys(names: readonly string[]): Promise<TestWorkloadKeys> {
  const dir = mkdtempSync(join(tmpdir(), 'ga-keys-'));
  const workloads: Record<string, { keys: JWK[] }> = {};
  for (const name of new Set(names)) {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
    const pub = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(pub);
    writeFileSync(
      join(dir, `${name}.jwk.json`),
      JSON.stringify({ ...(await exportJWK(privateKey)), kid, alg: 'EdDSA' }),
      { mode: 0o600 },
    );
    workloads[name] = {
      keys: [{ kty: 'OKP', crv: 'Ed25519', x: pub.x as string, kid, alg: 'EdDSA' }],
    };
  }
  const keysFile = join(dir, 'workload-keys.json');
  writeFileSync(keysFile, JSON.stringify({ workloads }));
  const keyFile = (name: string) => join(dir, `${name}.jwk.json`);
  return {
    dir,
    keysFile,
    keyFile,
    signingKey: (name) => readSigningKey(keyFile(name)),
    env: (name) => ({ WORKLOAD_KEY_FILE: keyFile(name), WORKLOAD_KEYS_FILE: keysFile }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
