import { generateKeyPair, SignJWT, UnsecuredJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestWorkloadKeys, type TestWorkloadKeys } from '../testing/workload-keys.ts';
import {
  CALLER_TOKEN_TYPE,
  keySetsOf,
  PRINCIPAL_AUDIENCE,
  PRINCIPAL_TOKEN_TYPE,
  signCallerToken,
  signPrincipalToken,
  TokenError,
  verifyCallerToken,
  verifyPrincipalToken,
} from './tokens.ts';
import { readWorkloadKeyMap, type SigningKey } from './workload-keys.ts';

const USER_ID = '01900000-0000-7000-8000-000000000001';

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TokenError) return error.reason;
    throw error;
  }
  throw new Error('expected a TokenError');
}

describe('workload tokens', () => {
  let keys: TestWorkloadKeys;
  let gateway: SigningKey;
  let booking: SigningKey;
  let keySets: ReturnType<typeof keySetsOf>;
  const now = () => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    keys = await createTestWorkloadKeys(['gateway', 'booking-service', 'house-service']);
    gateway = await keys.signingKey('gateway');
    booking = await keys.signingKey('booking-service');
    keySets = keySetsOf(readWorkloadKeyMap(keys.keysFile));
  });
  afterAll(() => keys.dispose());

  /** A token with arbitrary header and claims, signed by `key`. */
  const forge = (
    key: SigningKey,
    header: Record<string, unknown>,
    claims: Record<string, unknown>,
  ) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', kid: key.kid, ...header }).sign(key.key);

  describe('caller assertions', () => {
    it('name the calling workload when addressed to this one', async () => {
      const token = await signCallerToken(booking, 'booking-service', 'house-service');
      await expect(verifyCallerToken(token, 'house-service', keySets)).resolves.toBe(
        'booking-service',
      );
    });

    it('are rejected when addressed to another workload', async () => {
      const token = await signCallerToken(booking, 'booking-service', 'user-service');
      expect(await failure(verifyCallerToken(token, 'house-service', keySets))).toBe('invalid');
    });

    it('are rejected when signed with another workload key than they claim', async () => {
      const token = await signCallerToken(booking, 'gateway', 'house-service');
      expect(await failure(verifyCallerToken(token, 'house-service', keySets))).toBe('invalid');
    });

    it('report missing, tampered, expired and over-long tokens', async () => {
      expect(await failure(verifyCallerToken(undefined, 'house-service', keySets))).toBe('missing');
      const token = await signCallerToken(booking, 'booking-service', 'house-service');
      const [header, , signature] = token.split('.');
      const payload = Buffer.from(
        JSON.stringify({ iss: 'gateway', aud: 'house-service', iat: now(), exp: now() + 60 }),
      ).toString('base64url');
      expect(
        await failure(
          verifyCallerToken(`${header}.${payload}.${signature}`, 'house-service', keySets),
        ),
      ).toBe('invalid');
      const expired = await forge(
        booking,
        { typ: CALLER_TOKEN_TYPE },
        { iss: 'booking-service', aud: 'house-service', iat: now() - 120, exp: now() - 60 },
      );
      expect(await failure(verifyCallerToken(expired, 'house-service', keySets))).toBe('expired');
      const long = await forge(
        booking,
        { typ: CALLER_TOKEN_TYPE },
        { iss: 'booking-service', aud: 'house-service', iat: now(), exp: now() + 3600 },
      );
      expect(await failure(verifyCallerToken(long, 'house-service', keySets))).toBe('invalid');
    });

    it('reject alg:none, HS256 key confusion, a missing kid, a wrong typ and unknown workloads', async () => {
      const claims = { iss: 'booking-service', aud: 'house-service', iat: now(), exp: now() + 60 };
      const unsecured = new UnsecuredJWT(claims).encode();
      expect(await failure(verifyCallerToken(unsecured, 'house-service', keySets))).toBe('invalid');
      const secret = new TextEncoder().encode(booking.publicJwk.x);
      const hmac = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256', kid: booking.kid, typ: CALLER_TOKEN_TYPE })
        .sign(secret);
      expect(await failure(verifyCallerToken(hmac, 'house-service', keySets))).toBe('invalid');
      const noKid = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', typ: CALLER_TOKEN_TYPE })
        .sign(booking.key);
      expect(await failure(verifyCallerToken(noKid, 'house-service', keySets))).toBe('invalid');
      const principalTyp = await forge(booking, { typ: PRINCIPAL_TOKEN_TYPE }, claims);
      expect(await failure(verifyCallerToken(principalTyp, 'house-service', keySets))).toBe(
        'invalid',
      );
      const stranger = await generateKeyPair('EdDSA');
      const unknown = await new SignJWT({ ...claims, iss: 'payment-service' })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'x', typ: CALLER_TOKEN_TYPE })
        .sign(stranger.privateKey);
      expect(await failure(verifyCallerToken(unknown, 'house-service', keySets))).toBe('invalid');
    });
  });

  describe('principals', () => {
    it('round-trip a user and drop roles this version does not know', async () => {
      const token = await signPrincipalToken(
        gateway,
        'gateway',
        { kind: 'user', userId: USER_ID, roles: ['admin'] },
        60,
      );
      await expect(verifyPrincipalToken(token, ['gateway'], keySets)).resolves.toEqual({
        kind: 'user',
        userId: USER_ID,
        roles: ['admin'],
      });
      const future = await forge(
        gateway,
        { typ: PRINCIPAL_TOKEN_TYPE },
        {
          iss: 'gateway',
          aud: PRINCIPAL_AUDIENCE,
          iat: now(),
          exp: now() + 60,
          kind: 'user',
          sub: USER_ID,
          roles: ['admin', 'super-admin'],
        },
      );
      await expect(verifyPrincipalToken(future, ['gateway'], keySets)).resolves.toMatchObject({
        roles: ['admin'],
      });
    });

    it('round-trip an identity', async () => {
      const token = await signPrincipalToken(
        gateway,
        'gateway',
        {
          kind: 'identity',
          issuer: 'https://idp.example',
          subject: 'auth0|42',
          email: 'a@example.com',
        },
        60,
      );
      await expect(verifyPrincipalToken(token, ['gateway'], keySets)).resolves.toEqual({
        kind: 'identity',
        issuer: 'https://idp.example',
        subject: 'auth0|42',
        email: 'a@example.com',
      });
    });

    it('accept only edge signers', async () => {
      const forged = await signPrincipalToken(
        booking,
        'booking-service',
        { kind: 'user', userId: USER_ID, roles: ['admin'] },
        60,
      );
      expect(await failure(verifyPrincipalToken(forged, ['gateway'], keySets))).toBe('invalid');
    });

    it('cap the lifetime when signing and when verifying', async () => {
      expect(() =>
        signPrincipalToken(gateway, 'gateway', { kind: 'user', userId: USER_ID, roles: [] }, 121),
      ).toThrow(RangeError);
      const long = await forge(
        gateway,
        { typ: PRINCIPAL_TOKEN_TYPE },
        {
          iss: 'gateway',
          aud: PRINCIPAL_AUDIENCE,
          iat: now(),
          exp: now() + 600,
          kind: 'user',
          sub: USER_ID,
          roles: [],
        },
      );
      expect(await failure(verifyPrincipalToken(long, ['gateway'], keySets))).toBe('invalid');
    });

    it('reject malformed claims and a wrong audience', async () => {
      const notUuid = await forge(
        gateway,
        { typ: PRINCIPAL_TOKEN_TYPE },
        {
          iss: 'gateway',
          aud: PRINCIPAL_AUDIENCE,
          iat: now(),
          exp: now() + 60,
          kind: 'user',
          sub: 'auth0|42',
          roles: [],
        },
      );
      expect(await failure(verifyPrincipalToken(notUuid, ['gateway'], keySets))).toBe('invalid');
      const wrongAudience = await forge(
        gateway,
        { typ: PRINCIPAL_TOKEN_TYPE },
        {
          iss: 'gateway',
          aud: 'house-service',
          iat: now(),
          exp: now() + 60,
          kind: 'user',
          sub: USER_ID,
          roles: [],
        },
      );
      expect(await failure(verifyPrincipalToken(wrongAudience, ['gateway'], keySets))).toBe(
        'invalid',
      );
    });
  });
});
