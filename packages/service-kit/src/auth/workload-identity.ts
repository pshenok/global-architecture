import { readFileSync } from 'node:fs';
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
import { actorFromClaims, type IssuedPrincipal, issuedPrincipal } from './principal-context.ts';
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
  parseSigningKey,
  parseWorkloadKeyMap,
  readSigningKeyText,
  readWorkloadKeyMapText,
  type SigningKey,
  type WorkloadKeyMap,
} from './workload-keys.ts';

interface CachedCallerToken {
  readonly token: string;
  readonly refreshAt: number;
}

/** Whether `map` publishes `key` as one of `name`'s public keys. */
const publishes = (map: WorkloadKeyMap, name: string, key: SigningKey): boolean =>
  map
    .get(name)
    ?.some((published) => published.kid === key.kid && published.x === key.publicJwk.x) ?? false;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The event bus calls no service (ADR-0005 #4), so it never signs a caller assertion,
 * whatever code it runs; every service refuses a call without one (CALLER_MISSING).
 */
const EVENT_BUS = 'event-bus-service';

/**
 * This workload's identity: its private key (signs caller assertions, and user
 * principals when it is an edge) and every workload's public keys (verifies what
 * others signed). Both files are re-read every WORKLOAD_KEYS_RELOAD_S, so keys rotate
 * without restarts: a broken map keeps the last good one, and a new private key is
 * used only once the map publishes its public half.
 */
export class WorkloadIdentity implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkloadIdentity.name);
  private map: WorkloadKeyMap;
  private keySets: ReadonlyMap<string, JWTVerifyGetKey>;
  private mapText: string;
  private keyText: string;
  private readonly callerTokens = new Map<string, Promise<CachedCallerToken>>();
  private readonly timer: NodeJS.Timeout;

  private constructor(
    readonly name: string,
    private signingKey: SigningKey,
    keyText: string,
    map: WorkloadKeyMap,
    mapText: string,
    private readonly config: WorkloadIdentityConfig,
  ) {
    this.map = map;
    this.keySets = keySetsOf(map);
    this.mapText = mapText;
    this.keyText = keyText;
    this.timer = setInterval(() => void this.reload(), config.WORKLOAD_KEYS_RELOAD_S * 1_000);
    this.timer.unref();
  }

  /** Loads the keys; throws (fails boot) when a file is missing or invalid. */
  static async load(name: string, config: WorkloadIdentityConfig): Promise<WorkloadIdentity> {
    const keyText = readSigningKeyText(config.WORKLOAD_KEY_FILE);
    const signingKey = await parseSigningKey(
      keyText,
      `WORKLOAD_KEY_FILE=${config.WORKLOAD_KEY_FILE}`,
    );
    // One read per file: what is parsed is what reload() later compares against.
    const mapText = readWorkloadKeyMapText(config.WORKLOAD_KEYS_FILE);
    const map = parseWorkloadKeyMap(mapText, `WORKLOAD_KEYS_FILE=${config.WORKLOAD_KEYS_FILE}`);
    if (!publishes(map, name, signingKey)) {
      throw new Error(
        `WORKLOAD_KEYS_FILE has no public key ${signingKey.kid} for workload ${name}: publish the new public key before switching the private key`,
      );
    }
    const identity = new WorkloadIdentity(name, signingKey, keyText, map, mapText, config);
    identity.logger.log(`workload ${name} signs with key ${signingKey.kid}; ${summary(map)}`);
    return identity;
  }

  /** The key id this workload signs with now. */
  get signingKid(): string {
    return this.signingKey.kid;
  }

  /** Workloads allowed to sign user principals. */
  get principalIssuers(): readonly string[] {
    return this.config.PRINCIPAL_ISSUERS;
  }

  get isEdge(): boolean {
    return this.config.PRINCIPAL_ISSUERS.includes(this.name);
  }

  /**
   * Caller assertion for an outbound call to `target`; cached until half its lifetime is
   * left. The event bus gets none: it calls nobody.
   */
  async callerToken(target: string): Promise<string> {
    if (this.name === EVENT_BUS) {
      throw new Error(`${EVENT_BUS} calls no service (ADR-0005), so it signs no call to ${target}`);
    }
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
  async issuePrincipal(claims: PrincipalClaims, ttlSeconds: number): Promise<IssuedPrincipal> {
    if (!this.isEdge) {
      throw new Error(
        `workload ${this.name} is not in PRINCIPAL_ISSUERS and may not sign principals`,
      );
    }
    const token = await signPrincipalToken(this.signingKey, this.name, claims, ttlSeconds);
    return issuedPrincipal(token, actorFromClaims(claims));
  }

  /** Returns the workload that signed a caller assertion addressed to this workload. */
  verifyCaller(token: string | undefined): Promise<string> {
    return verifyCallerToken(token, this.name, this.keySets);
  }

  verifyPrincipal(token: string | undefined): Promise<PrincipalClaims> {
    return verifyPrincipalToken(token, this.config.PRINCIPAL_ISSUERS, this.keySets);
  }

  /**
   * Re-reads both key files (also runs every WORKLOAD_KEYS_RELOAD_S). Never throws:
   * problems are logged and the last good keys stay in use.
   */
  async reload(): Promise<void> {
    this.reloadMap();
    await this.reloadSigningKey();
    if (!publishes(this.map, this.name, this.signingKey)) {
      this.logger.error(
        `WORKLOAD_KEYS_FILE no longer publishes this workload's signing key ${this.signingKey.kid}: other workloads refuse its calls until WORKLOAD_KEY_FILE holds a published key`,
      );
    }
  }

  private reloadMap(): void {
    try {
      const text = readFileSync(this.config.WORKLOAD_KEYS_FILE, 'utf8');
      if (text === this.mapText) return;
      const map = parseWorkloadKeyMap(text, `WORKLOAD_KEYS_FILE=${this.config.WORKLOAD_KEYS_FILE}`);
      this.map = map;
      this.keySets = keySetsOf(map);
      this.mapText = text;
      this.logger.log(`workload keys reloaded; ${summary(map)}`);
    } catch (error) {
      this.logger.error(`workload keys not reloaded, keeping the last good set: ${message(error)}`);
    }
  }

  /**
   * Switches to a new private key once this workload's map publishes it (rotation step 3).
   * Other workloads may not have reloaded the map yet; the runbook's step 2 covers that.
   */
  private async reloadSigningKey(): Promise<void> {
    try {
      const text = readSigningKeyText(this.config.WORKLOAD_KEY_FILE);
      if (text === this.keyText) return;
      const next = await parseSigningKey(
        text,
        `WORKLOAD_KEY_FILE=${this.config.WORKLOAD_KEY_FILE}`,
      );
      if (!publishes(this.map, this.name, next)) {
        throw new Error(
          `its new key ${next.kid} is not in WORKLOAD_KEYS_FILE yet (publish the public key first)`,
        );
      }
      this.signingKey = next;
      this.keyText = text;
      this.callerTokens.clear();
      this.logger.log(`workload ${this.name} now signs with key ${next.kid}`);
    } catch (error) {
      this.logger.error(
        `WORKLOAD_KEY_FILE not reloaded, still signing with ${this.signingKey.kid}: ${message(error)}`,
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
        {
          provide: WorkloadIdentity,
          inject: [CONFIG],
          useFactory: (config: WorkloadIdentityConfig) =>
            WorkloadIdentity.load(options.name, config),
        },
      ],
      exports: [WorkloadIdentity],
    };
  }
}
