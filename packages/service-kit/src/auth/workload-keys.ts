import { readFileSync } from 'node:fs';
import { importJWK, type JWK } from 'jose';
import { z } from 'zod';

/** At most this many public keys per workload: the current one plus rotations in flight. */
export const MAX_KEYS_PER_WORKLOAD = 5;

const base64url43 = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be a 32-byte base64url value');

const PublicJwk = z
  .object({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: base64url43,
    kid: z.string().min(1).max(128),
    alg: z.literal('EdDSA').optional(),
    use: z.literal('sig').optional(),
  })
  .strict();

const PrivateJwk = PublicJwk.extend({ d: base64url43 }).strict();

const KeyMap = z
  .object({
    workloads: z.record(
      z.string().regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, 'workload names are kebab-case'),
      z.object({ keys: z.array(PublicJwk).min(1).max(MAX_KEYS_PER_WORKLOAD) }).strict(),
    ),
  })
  .strict();

export type PublicWorkloadJwk = z.output<typeof PublicJwk>;

/** Public keys per workload name. */
export type WorkloadKeyMap = ReadonlyMap<string, readonly PublicWorkloadJwk[]>;

export interface SigningKey {
  readonly kid: string;
  readonly key: CryptoKey;
  /** The matching public JWK (what other workloads must trust). */
  readonly publicJwk: PublicWorkloadJwk;
}

const PRIVATE_MEMBERS = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']);

function containsPrivateMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateMaterial);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, member]) => PRIVATE_MEMBERS.has(key) || containsPrivateMaterial(member),
    );
  }
  return false;
}

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
}

/** Parses and validates a workload key map. Throws a readable error for anything unexpected. */
export function parseWorkloadKeyMap(text: string, source: string): WorkloadKeyMap {
  const json = parseJson(text, source);
  if (containsPrivateMaterial(json)) {
    throw new Error(`${source} contains private key material; it must hold public keys only`);
  }
  const parsed = KeyMap.safeParse(json);
  if (!parsed.success) throw new Error(`${source} is invalid: ${describe(parsed.error)}`);
  const map = new Map<string, readonly PublicWorkloadJwk[]>();
  for (const [name, { keys }] of Object.entries(parsed.data.workloads)) {
    const kids = new Set(keys.map((key) => key.kid));
    if (kids.size !== keys.length)
      throw new Error(`${source}: workload ${name} has duplicate kids`);
    map.set(name, Object.freeze(keys.map((key) => Object.freeze({ ...key }))));
  }
  return map;
}

export function readWorkloadKeyMap(file: string): WorkloadKeyMap {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(
      `WORKLOAD_KEYS_FILE=${file} cannot be read (run \`pnpm keys\` locally): ${String(error)}`,
    );
  }
  return parseWorkloadKeyMap(text, `WORKLOAD_KEYS_FILE=${file}`);
}

/** Loads this workload's private signing key (an Ed25519 JWK with `d`). */
export async function readSigningKey(file: string): Promise<SigningKey> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(
      `WORKLOAD_KEY_FILE=${file} cannot be read (run \`pnpm keys\` locally): ${String(error)}`,
    );
  }
  const parsed = PrivateJwk.safeParse(parseJson(text, `WORKLOAD_KEY_FILE=${file}`));
  if (!parsed.success) {
    throw new Error(
      `WORKLOAD_KEY_FILE=${file} is not an Ed25519 private JWK: ${describe(parsed.error)}`,
    );
  }
  const { d: _private, ...publicJwk } = parsed.data;
  const key = (await importJWK(parsed.data as JWK, 'EdDSA')) as CryptoKey;
  return { kid: parsed.data.kid, key, publicJwk: Object.freeze(publicJwk) };
}
