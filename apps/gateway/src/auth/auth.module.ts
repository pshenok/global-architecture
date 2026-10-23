import { CONFIG } from '@ga/service-kit';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { AccessTokenVerifier } from './access-token-verifier.ts';
import type { AuthConfig } from './auth.config.ts';
import { GrpcIdentityResolver, IdentityResolver } from './identity-resolver.ts';
import { IdpKeySet } from './idp-key-set.ts';

/** One key set per trusted issuer, started at boot (not blocking it). */
export const IDP_KEY_SETS = Symbol('IDP_KEY_SETS');

class IdpKeySetsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(IDP_KEY_SETS) private readonly keySets: ReadonlyMap<string, IdpKeySet>) {}

  onApplicationShutdown(): void {
    for (const keySet of this.keySets.values()) keySet.stop();
  }
}

/** Authentication building blocks of the gateway; AuthGuard is bound in AppModule. */
@Global()
@Module({
  providers: [
    {
      provide: IDP_KEY_SETS,
      inject: [CONFIG],
      useFactory: (config: AuthConfig) => {
        const keySets = new Map<string, IdpKeySet>();
        for (const issuer of config.AUTH_ISSUERS) {
          const keySet = new IdpKeySet(issuer.jwksUri, {
            refreshMs: config.AUTH_JWKS_REFRESH_S * 1_000,
            unknownKidCooldownMs: config.AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S * 1_000,
            maxStaleMs: config.AUTH_JWKS_MAX_STALE_S * 1_000,
            timeoutMs: config.AUTH_JWKS_TIMEOUT_MS,
          });
          keySet.start();
          keySets.set(issuer.issuer, keySet);
        }
        return keySets;
      },
    },
    {
      provide: AccessTokenVerifier,
      inject: [CONFIG, IDP_KEY_SETS],
      useFactory: (config: AuthConfig, keySets: ReadonlyMap<string, IdpKeySet>) =>
        new AccessTokenVerifier(
          new Map(
            config.AUTH_ISSUERS.map((issuer) => [
              issuer.issuer,
              { config: issuer, keys: keySets.get(issuer.issuer) as IdpKeySet },
            ]),
          ),
          config.AUTH_CLOCK_TOLERANCE_S,
        ),
    },
    { provide: IdentityResolver, useClass: GrpcIdentityResolver },
    IdpKeySetsLifecycle,
  ],
  exports: [IDP_KEY_SETS, AccessTokenVerifier, IdentityResolver],
})
export class AuthModule {}
