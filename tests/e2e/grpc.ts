import { readFileSync } from 'node:fs';
import { Metadata } from '@grpc/grpc-js';
import { importJWK, type JWK, SignJWT } from 'jose';

const ROOT = new URL('../../', import.meta.url);
/** CA of the services' gRPC certificates (pnpm certs). */
export const GRPC_CA = new URL('.certs/grpc-ca.pem', ROOT).pathname;

const registry = JSON.parse(readFileSync(new URL('services.json', ROOT), 'utf8')) as {
  services: { name: string; grpcPort: number; grpcService: string; protoFile: string }[];
};

export function serviceTarget(name: string) {
  const service = registry.services.find((s) => s.name === name);
  if (!service) throw new Error(`unknown service ${name}`);
  return {
    url: `localhost:${service.grpcPort}`,
    grpcService: service.grpcService,
    protoFile: service.protoFile,
  };
}

async function signingKey(workload: string) {
  const jwk = JSON.parse(
    readFileSync(new URL(`.certs/workloads/${workload}.jwk.json`, ROOT), 'utf8'),
  ) as JWK & { kid: string };
  return { kid: jwk.kid, key: await importJWK(jwk, 'EdDSA') };
}

const now = () => Math.floor(Date.now() / 1_000);

/** A caller assertion signed with a local workload key (what the service kit does per hop). */
export async function callerToken(from: string, to: string): Promise<string> {
  const { kid, key } = await signingKey(from);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', typ: 'ga-caller+jwt', kid })
    .setIssuer(from)
    .setAudience(to)
    .setIssuedAt(now())
    .setExpirationTime(now() + 60)
    .sign(key);
}

/** A user principal signed by `signer` (only the gateway's are accepted). */
export async function principalToken(
  signer: string,
  userId: string,
  roles: string[] = [],
): Promise<string> {
  const { kid, key } = await signingKey(signer);
  return new SignJWT({ kind: 'user', sub: userId, roles })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'ga-principal+jwt', kid })
    .setIssuer(signer)
    .setAudience('ga-services')
    .setIssuedAt(now())
    .setExpirationTime(now() + 60)
    .sign(key);
}

export function metadataOf(entries: Record<string, string>): Metadata {
  const metadata = new Metadata();
  for (const [key, value] of Object.entries(entries)) metadata.set(key, value);
  return metadata;
}
