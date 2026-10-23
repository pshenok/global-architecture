import { readFileSync } from 'node:fs';
import type { IdentityActor, UserActor } from '@ga/kernel';
import {
  type DynamicModule,
  Global,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { JWTVerifyGetKey } from 'jose';
import { CONFIG } from '../config/config.ts';
import type { WorkloadIdentityConfig } from './config.ts';
import { actorFromClaims } from './principal-context.ts';
import {
  CALLER_TOKEN_TTL_S,
  keySetsOf,
  type PrincipalClaims,
  signCallerToken,
  signPrincipalToken,
  verifyCallerToken,
  verifyPrincipalToken,
} from './tokens.ts';
import {
  parseWorkloadKeyMap,
  readSigningKey,
  readWorkloadKeyMap,
  type SigningKey,
  type WorkloadKeyMap,
} from './workload-keys.ts';

interface CachedCallerToken {
  readonly token: string;
  readonly refreshAt: number;
}

/**
 * This workload's identity: its private key (signs caller assertions, and user
 * principals when it is an edge) and every workload's public keys (verifies what
 * others signed). The public key map is re-read periodically, so keys rotate
 * without restarts; a broken file keeps the last good map.
 */
export class WorkloadIdentity implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkloadIdentity.name);
  private keySets: ReadonlyMap<string, JWTVerifyGetKey>;
  private mapText: string;
  private readonly callerTokens = new Map<string, Promise<CachedCallerToken>>();
  private readonly timer: NodeJS.Timeout;

  private constructor(
    readonly name: string,
    private readonly signingKey: SigningKey,
    map: WorkloadKeyMap,
    mapText: string,
    private readonly config: WorkloadIdentityConfig,
  ) {
    this.keySets = keySetsOf(map);
    this.mapText = mapText;
    this.timer = setInterval(() => this.reload(), config.WORKLOAD_KEYS_RELOAD_S * 1_000);
    this.timer.unref();
  }

  /** Loads the keys; throws (fails boot) when a file is missing or invalid. */
  static async load(name: string, config: WorkloadIdentityConfig): Promise<WorkloadIdentity> {
    const signingKey = await readSigningKey(config.WORKLOAD_KEY_FILE);
    const map = readWorkloadKeyMap(config.WORKLOAD_KEYS_FILE);
    const own = map.get(name)?.find((key) => key.kid === signingKey.kid);
    if (!own || own.x !== signingKey.publicJwk.x) {
      throw new Error(
        `WORKLOAD_KEYS_FILE has no public key ${signingKey.kid} for workload ${name}: publish the new public key before switching the private key`,
      );
    }
    const identity = new WorkloadIdentity(
      name,
      signingKey,
      map,
      readFileSync(config.WORKLOAD_KEYS_FILE, 'utf8'),
      config,
    );
    identity.logger.log(`workload ${name} signs with key ${signingKey.kid}; ${summary(map)}`);
    return identity;
  }

  /** Workloads allowed to sign user principals. */
  get principalIssuers(): readonly string[] {
    return this.config.PRINCIPAL_ISSUERS;
  }

  get isEdge(): boolean {
    return this.config.PRINCIPAL_ISSUERS.includes(this.name);
  }

  /** Caller assertion for an outbound call to `target`; cached until half its lifetime is left. */
  async callerToken(target: string): Promise<string> {
    const cached = this.callerTokens.get(target);
    if (cached) {
      const value = await cached;
      if (Date.now() < value.refreshAt) return value.token;
    }
    const pending = signCallerToken(this.signingKey, this.name, target).then((token) => ({
      token,
      refreshAt: Date.now() + (CALLER_TOKEN_TTL_S * 1_000) / 2,
    }));
    this.callerTokens.set(target, pending);
    try {
      return (await pending).token;
    } catch (error) {
      this.callerTokens.delete(target);
      throw error;
    }
  }

  /**
   * Signs a principal for the current request and returns it with its actor (pass both
   * to `enterPrincipal`). Only edge workloads (PRINCIPAL_ISSUERS) may.
   */
  async issuePrincipal(
    claims: PrincipalClaims,
    ttlSeconds: number,
  ): Promise<{ readonly token: string; readonly actor: UserActor | IdentityActor }> {
    if (!this.isEdge) {
      throw new Error(
        `workload ${this.name} is not in PRINCIPAL_ISSUERS and may not sign principals`,
      );
    }
    const token = await signPrincipalToken(this.signingKey, this.name, claims, ttlSeconds);
    return { token, actor: actorFromClaims(claims) };
  }

  /** Returns the workload that signed a caller assertion addressed to this workload. */
  verifyCaller(token: string | undefined): Promise<string> {
    return verifyCallerToken(token, this.name, this.keySets);
  }

  verifyPrincipal(token: string | undefined): Promise<PrincipalClaims> {
    return verifyPrincipalToken(token, this.config.PRINCIPAL_ISSUERS, this.keySets);
  }

  /** Re-reads the public key map; keeps the last good one when the file is unreadable or invalid. */
  reload(): void {
    let text: string;
    try {
      text = readFileSync(this.config.WORKLOAD_KEYS_FILE, 'utf8');
      if (text === this.mapText) return;
      const map = parseWorkloadKeyMap(text, `WORKLOAD_KEYS_FILE=${this.config.WORKLOAD_KEYS_FILE}`);
      this.keySets = keySetsOf(map);
      this.mapText = text;
      this.logger.log(`workload keys reloaded; ${summary(map)}`);
    } catch (error) {
      this.logger.error(
        `workload keys not reloaded, keeping the last good set: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }
}

function summary(map: WorkloadKeyMap): string {
  return `trusts ${[...map].map(([name, keys]) => `${name}[${keys.map((key) => key.kid.slice(0, 8)).join(',')}]`).join(' ')}`;
}

/** DI token of this workload's name. */
export const WORKLOAD_NAME = Symbol('WORKLOAD_NAME');

/**
 * Provides {@link WorkloadIdentity} globally. GrpcPlatformModule imports it with the
 * service name; the gateway imports it as `gateway`.
 */
@Global()
@Module({})
export class WorkloadIdentityModule {
  static forRoot(options: { readonly name: string }): DynamicModule {
    return {
      module: WorkloadIdentityModule,
      providers: [
        { provide: WORKLOAD_NAME, useValue: options.name },
        {
          provide: WorkloadIdentity,
          inject: [CONFIG],
          useFactory: (config: WorkloadIdentityConfig) =>
            WorkloadIdentity.load(options.name, config),
        },
      ],
      exports: [WORKLOAD_NAME, WorkloadIdentity],
    };
  }
}
