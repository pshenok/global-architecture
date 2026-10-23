import { ROLES, type Role } from '@ga/kernel';
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from 'jose';
import { z } from 'zod';
import type { PublicWorkloadJwk, SigningKey } from './workload-keys.ts';

/** gRPC metadata key of the calling workload's assertion (signed by the caller, per hop). */
export const CALLER_METADATA_KEY = 'x-ga-caller';
/** gRPC metadata key of the end user's principal (signed by an edge, forwarded unchanged). */
export const PRINCIPAL_METADATA_KEY = 'x-ga-principal';

export const CALLER_TOKEN_TYPE = 'ga-caller+jwt';
export const PRINCIPAL_TOKEN_TYPE = 'ga-principal+jwt';
/** Audience of every principal: any service may receive it, but only from an allowed caller. */
export const PRINCIPAL_AUDIENCE = 'ga-services';

/** Lifetime of a caller assertion; signers re-sign when less than half remains. */
export const CALLER_TOKEN_TTL_S = 60;
/** Upper bound of a principal's lifetime, enforced when signing and when verifying. */
export const PRINCIPAL_MAX_TTL_S = 120;
/** Clock skew tolerated between workloads. */
export const TOKEN_CLOCK_TOLERANCE_S = 5;

const MAX_TOKEN_LENGTH = 4_096;

/** What a principal says about the end user. */
export type PrincipalClaims =
  | { readonly kind: 'user'; readonly userId: string; readonly roles: readonly Role[] }
  | {
      readonly kind: 'identity';
      readonly issuer: string;
      readonly subject: string;
      readonly email: string | null;
    };

const WirePrincipal = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    sub: z.uuid(),
    roles: z.array(z.string().max(64)).max(32),
  }),
  z.object({
    kind: z.literal('identity'),
    idp: z.object({ iss: z.string().min(1).max(2_048), sub: z.string().min(1).max(255) }),
    email: z.email().max(254).nullable(),
  }),
]);

export type TokenFailure = 'missing' | 'invalid' | 'expired';

/** A token that failed verification; `reason` tells callers which error to raise. */
export class TokenError extends Error {
  constructor(
    readonly reason: TokenFailure,
    message: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1_000);

/** Caller assertion: "workload `issuer` calls workload `audience`", valid for 60 s. */
export function signCallerToken(
  key: SigningKey,
  issuer: string,
  audience: string,
): Promise<string> {
  const now = nowSeconds();
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', typ: CALLER_TOKEN_TYPE, kid: key.kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + CALLER_TOKEN_TTL_S)
    .sign(key.key);
}

/** Principal: who the end user is, signed by an edge workload. */
export function signPrincipalToken(
  key: SigningKey,
  issuer: string,
  claims: PrincipalClaims,
  ttlSeconds: number,
): Promise<string> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > PRINCIPAL_MAX_TTL_S) {
    throw new RangeError(`principal TTL must be 1..${PRINCIPAL_MAX_TTL_S} seconds`);
  }
  const wire =
    claims.kind === 'user'
      ? { kind: 'user', sub: claims.userId, roles: [...claims.roles] }
      : { kind: 'identity', idp: { iss: claims.issuer, sub: claims.subject }, email: claims.email };
  const now = nowSeconds();
  return new SignJWT(wire)
    .setProtectedHeader({ alg: 'EdDSA', typ: PRINCIPAL_TOKEN_TYPE, kid: key.kid })
    .setIssuer(issuer)
    .setAudience(PRINCIPAL_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key.key);
}

/** One local JWKS per workload; rebuilt when the key map is reloaded. */
export function keySetsOf(
  map: ReadonlyMap<string, readonly PublicWorkloadJwk[]>,
): ReadonlyMap<string, JWTVerifyGetKey> {
  return new Map(
    [...map].map(([name, keys]) => [
      name,
      createLocalJWKSet({
        keys: keys.map(({ kty, crv, x, kid }) => ({ kty, crv, x, kid, alg: 'EdDSA' })),
      }),
    ]),
  );
}

async function verify(
  token: string | undefined,
  options: {
    readonly type: string;
    readonly audience: string;
    readonly issuers: readonly string[] | null;
    readonly keySets: ReadonlyMap<string, JWTVerifyGetKey>;
    readonly maxTtlSeconds: number;
  },
): Promise<JWTPayload> {
  if (!token) throw new TokenError('missing', 'no token');
  if (token.length > MAX_TOKEN_LENGTH) throw new TokenError('invalid', 'token too long');
  let issuer: unknown;
  let kid: unknown;
  try {
    issuer = decodeJwt(token).iss;
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new TokenError('invalid', 'malformed token');
  }
  if (typeof kid !== 'string') throw new TokenError('invalid', 'token header has no kid');
  if (typeof issuer !== 'string') throw new TokenError('invalid', 'token has no issuer');
  if (options.issuers && !options.issuers.includes(issuer)) {
    throw new TokenError('invalid', `issuer ${issuer} may not sign this token`);
  }
  const keySet = options.keySets.get(issuer);
  if (!keySet) throw new TokenError('invalid', `no keys for workload ${issuer}`);
  try {
    const { payload } = await jwtVerify(token, keySet, {
      algorithms: ['EdDSA'],
      typ: options.type,
      issuer,
      audience: options.audience,
      clockTolerance: TOKEN_CLOCK_TOLERANCE_S,
      requiredClaims: ['iat', 'exp'],
    });
    const lifetime = (payload.exp as number) - (payload.iat as number);
    if (lifetime > options.maxTtlSeconds)
      throw new TokenError('invalid', 'token lifetime too long');
    if ((payload.iat as number) > nowSeconds() + TOKEN_CLOCK_TOLERANCE_S) {
      throw new TokenError('invalid', 'token issued in the future');
    }
    return payload;
  } catch (error) {
    if (error instanceof TokenError) throw error;
    if (error instanceof errors.JWTExpired) throw new TokenError('expired', 'token expired');
    throw new TokenError('invalid', 'token verification failed');
  }
}

/** Verifies a caller assertion addressed to `self`; returns the calling workload. */
export async function verifyCallerToken(
  token: string | undefined,
  self: string,
  keySets: ReadonlyMap<string, JWTVerifyGetKey>,
): Promise<string> {
  const payload = await verify(token, {
    type: CALLER_TOKEN_TYPE,
    audience: self,
    issuers: null,
    keySets,
    maxTtlSeconds: CALLER_TOKEN_TTL_S,
  });
  return payload.iss as string;
}

/** Verifies a principal signed by one of `issuers` (the edges). Unknown roles are dropped. */
export async function verifyPrincipalToken(
  token: string | undefined,
  issuers: readonly string[],
  keySets: ReadonlyMap<string, JWTVerifyGetKey>,
): Promise<PrincipalClaims> {
  const payload = await verify(token, {
    type: PRINCIPAL_TOKEN_TYPE,
    audience: PRINCIPAL_AUDIENCE,
    issuers,
    keySets,
    maxTtlSeconds: PRINCIPAL_MAX_TTL_S,
  });
  const parsed = WirePrincipal.safeParse(payload);
  if (!parsed.success) throw new TokenError('invalid', 'principal claims are invalid');
  const wire = parsed.data;
  if (wire.kind === 'user') {
    const roles = wire.roles.filter((role): role is Role =>
      (ROLES as readonly string[]).includes(role),
    );
    return { kind: 'user', userId: wire.sub, roles };
  }
  return { kind: 'identity', issuer: wire.idp.iss, subject: wire.idp.sub, email: wire.email };
}
