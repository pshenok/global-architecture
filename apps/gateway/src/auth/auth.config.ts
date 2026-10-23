import { isLoopbackHost } from '@ga/service-kit';
import { z } from 'zod';

/** How the gateway decides which email a new user gets from an identity provider. */
export const EMAIL_POLICIES = ['verified-claim', 'userinfo', 'trusted-claim', 'none'] as const;
export type EmailPolicy = (typeof EMAIL_POLICIES)[number];

/** Asymmetric algorithms only: `none` and HS* (shared secrets) can never be configured. */
const Algorithm = z.enum([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
]);

const IssuerSchema = z
  .object({
    /** Exact `iss` claim of the provider's access tokens. */
    issuer: z.string().min(1).max(2_048),
    /** Audience the access tokens must carry: this API's identifier, never a client id. */
    audience: z.string().min(1).max(2_048),
    jwksUri: z.url(),
    algorithms: z.array(Algorithm).min(1).default(['RS256', 'ES256']),
    userinfoUri: z.url().optional(),
    /** Required JWT `typ` header (e.g. `at+jwt`, RFC 9068), when the provider sets one. */
    requiredTyp: z.string().min(1).optional(),
    emailPolicy: z.enum(EMAIL_POLICIES).default('verified-claim'),
  })
  .strict()
  .refine((issuer) => issuer.emailPolicy !== 'userinfo' || issuer.userinfoUri, {
    message: 'emailPolicy "userinfo" needs userinfoUri',
  });

export type IssuerConfig = z.output<typeof IssuerSchema>;

/** Every identity-provider URL must be https, except loopback outside production. */
export function checkIssuerUrls(
  issuers: readonly IssuerConfig[],
  production: boolean,
  addIssue: (message: string) => void,
): void {
  for (const issuer of issuers) {
    for (const [field, value] of [
      ['jwksUri', issuer.jwksUri],
      ['userinfoUri', issuer.userinfoUri],
    ] as const) {
      if (!value) continue;
      const url = new URL(value);
      const local = isLoopbackHost(url.hostname) && !production;
      if (url.protocol !== 'https:' && !local) {
        addIssue(`AUTH_ISSUERS ${issuer.issuer}: ${field} must use https`);
      }
    }
  }
  const names = issuers.map((issuer) => issuer.issuer);
  if (new Set(names).size !== names.length) addIssue('AUTH_ISSUERS lists an issuer twice');
}

/** Gateway authentication settings (ADR-0004). */
export const authConfigSchema = z.object({
  /** JSON array of 1..5 trusted identity providers (two during an IdP migration). */
  AUTH_ISSUERS: z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be a JSON array of issuers' });
        return z.NEVER;
      }
    })
    .pipe(z.array(IssuerSchema).min(1).max(5)),
  AUTH_CLOCK_TOLERANCE_S: z.coerce.number().int().min(0).max(120).default(30),
  AUTH_JWKS_REFRESH_S: z.coerce.number().int().min(10).max(86_400).default(300),
  /** At most one extra JWKS fetch per this interval for tokens signed with an unknown key. */
  AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S: z.coerce.number().int().min(0).max(3_600).default(30),
  /** Keys older than this (no successful refresh) are not used: requests get 503. */
  AUTH_JWKS_MAX_STALE_S: z.coerce.number().int().min(60).max(86_400).default(3_600),
  AUTH_JWKS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3_000),
  IDENTITY_CACHE_TTL_S: z.coerce.number().int().min(1).max(3_600).default(60),
  /** How long a known mapping keeps serving while user-service is unreachable. */
  IDENTITY_CACHE_STALE_IF_ERROR_S: z.coerce.number().int().min(0).max(86_400).default(900),
  IDENTITY_CACHE_NEGATIVE_TTL_S: z.coerce.number().int().min(0).max(300).default(5),
  IDENTITY_CACHE_MAX_ENTRIES: z.coerce.number().int().min(100).max(1_000_000).default(10_000),
  /** Lifetime of the principals the gateway signs (at most 120 s). */
  PRINCIPAL_TOKEN_TTL_S: z.coerce.number().int().min(5).max(120).default(60),
});

export type AuthConfig = z.output<typeof authConfigSchema>;
