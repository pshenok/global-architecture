/**
 * Local workload keys (ADR-0004), in .certs/ (git-ignored):
 *   .certs/workloads/<name>.jwk.json   private Ed25519 key of each workload (mode 0600)
 *   .certs/workload-keys.json          public keys of every workload (WORKLOAD_KEYS_FILE)
 *
 *   pnpm keys                    create missing keys for the gateway and every service in
 *                                services.json, and publish their public halves (idempotent)
 *   pnpm keys --rotate <name>    publish a new public key, wait until every workload has
 *                                reloaded the map (65 s), then replace the private key;
 *                                <name> switches to it on its next reload (60 s), no restart
 *   pnpm keys --prune <name>     drop every public key of <name> but the current one
 *                                (refused within 130 s of a rotation: the switch, plus the
 *                                lifetime of tokens signed with the old key)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';
import { WORKLOAD_KEYS_PATH, workloadKeyPath, workloadNames } from './lib.ts';

const MAX_KEYS = 5;
const RELOAD_MARGIN_MS = 65_000;
const PRUNE_AFTER_MS = 130_000;

type PublicKey = { kty: string; crv: string; x: string; kid: string; alg: 'EdDSA' };
type KeyMap = { workloads: Record<string, { keys: PublicKey[] }> };

/** Write through a temp file and rename, so a reader never sees half a file. */
function writeAtomic(file: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode });
  renameSync(temp, file);
}

async function newKey(): Promise<{ privateJwk: JWK; publicJwk: PublicKey }> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
  const pub = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(pub);
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: pub.x as string, kid, alg: 'EdDSA' } as const;
  return { privateJwk: { ...(await exportJWK(privateKey)), kid, alg: 'EdDSA' }, publicJwk };
}

const publicHalf = (jwk: JWK): PublicKey => ({
  kty: 'OKP',
  crv: 'Ed25519',
  x: jwk.x as string,
  kid: jwk.kid as string,
  alg: 'EdDSA',
});

const readMap = (): KeyMap =>
  existsSync(WORKLOAD_KEYS_PATH)
    ? (JSON.parse(readFileSync(WORKLOAD_KEYS_PATH, 'utf8')) as KeyMap)
    : { workloads: {} };
const writeMap = (map: KeyMap) =>
  writeAtomic(WORKLOAD_KEYS_PATH, `${JSON.stringify(map, null, 2)}\n`);
const readPrivate = (name: string) =>
  JSON.parse(readFileSync(workloadKeyPath(name), 'utf8')) as JWK;

async function ensure(): Promise<void> {
  const map = readMap();
  for (const name of workloadNames()) {
    if (!existsSync(workloadKeyPath(name))) {
      const { privateJwk } = await newKey();
      writeAtomic(workloadKeyPath(name), `${JSON.stringify(privateJwk)}\n`, 0o600);
      console.log(`created key for ${name}`);
    }
    const current = publicHalf(readPrivate(name));
    const entry = map.workloads[name] ?? { keys: [] };
    if (!entry.keys.some((key) => key.kid === current.kid)) entry.keys.push(current);
    map.workloads[name] = entry;
  }
  writeMap(map);
  console.log(`workload keys: ${WORKLOAD_KEYS_PATH}`);
}

async function rotate(name: string): Promise<void> {
  await ensure();
  const map = readMap();
  const keys = map.workloads[name]?.keys;
  if (!keys) throw new Error(`unknown workload ${name}`);
  if (keys.length >= MAX_KEYS) {
    throw new Error(
      `${name} already has ${MAX_KEYS} public keys: run pnpm keys --prune ${name} first`,
    );
  }
  const { privateJwk, publicJwk } = await newKey();
  keys.push(publicJwk);
  writeMap(map);
  console.log(
    `published ${publicJwk.kid} for ${name}; waiting ${RELOAD_MARGIN_MS / 1000} s for every workload to reload the map`,
  );
  await sleep(RELOAD_MARGIN_MS);
  writeAtomic(workloadKeyPath(name), `${JSON.stringify(privateJwk)}\n`, 0o600);
  console.log(
    `${name} switches to ${publicJwk.kid} within 60 s, no restart needed (it logs "now signs with key"); then pnpm keys --prune ${name}`,
  );
}

function prune(name: string): void {
  const age = Date.now() - statSync(workloadKeyPath(name)).mtimeMs;
  if (age < PRUNE_AFTER_MS) {
    throw new Error(
      `the key of ${name} changed ${Math.round(age / 1000)} s ago; tokens signed with the old key may still be in flight. Retry after ${PRUNE_AFTER_MS / 1000} s`,
    );
  }
  const current = publicHalf(readPrivate(name));
  const map = readMap();
  map.workloads[name] = { keys: [current] };
  writeMap(map);
  console.log(`${name}: only ${current.kid} is trusted now`);
}

const [flag, name] = process.argv.slice(2);
if (flag === '--rotate' && name) await rotate(name);
else if (flag === '--prune' && name) prune(name);
else if (flag === undefined) await ensure();
else {
  console.error('usage: pnpm keys [--rotate <workload> | --prune <workload>]');
  process.exit(1);
}
