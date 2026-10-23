import { DependencyUnavailableError } from '@ga/kernel';
import { Logger } from '@nestjs/common';
import {
  type CompactJWSHeaderParameters,
  createLocalJWKSet,
  type FlattenedJWSInput,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';

export type KeySetState = 'ok' | 'stale' | 'unavailable';

export interface IdpKeySetOptions {
  readonly refreshMs: number;
  readonly unknownKidCooldownMs: number;
  readonly maxStaleMs: number;
  readonly timeoutMs: number;
}

const COLD_RETRY_MIN_MS = 500;
const COLD_RETRY_MAX_MS = 5_000;

export const identityProviderUnavailable = () =>
  new DependencyUnavailableError(
    'IDENTITY_PROVIDER_UNAVAILABLE',
    'the identity provider cannot be reached; retry later',
  );

/**
 * Public keys of one identity provider, kept current in the background.
 *
 * jose's createRemoteJWKSet waits for a reload on the request path once its cache is
 * old and fails the request when that reload fails, so an IdP outage would turn into
 * slow 401s for everyone. Instead: refresh in the background, keep the last good keys
 * for up to `maxStaleMs` (then 503, never 401), and let a token with an unknown `kid`
 * trigger at most one extra fetch per cooldown (rotation within seconds, no hammering).
 */
export class IdpKeySet {
  private readonly logger = new Logger(IdpKeySet.name);
  private local: JWTVerifyGetKey | undefined;
  private kids = new Set<string>();
  private loadedAt = 0;
  private refreshing: Promise<boolean> | undefined;
  private lastUnknownKidRefresh = Number.NEGATIVE_INFINITY;
  private lastRefreshFailed = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    readonly jwksUri: string,
    private readonly options: IdpKeySetOptions,
    private readonly fetchJson: (url: string, timeoutMs: number) => Promise<unknown> = fetchJwks,
  ) {}

  /** Starts loading (retrying fast while cold) and the periodic refresh. Does not block. */
  start(): void {
    void this.coldStart(COLD_RETRY_MIN_MS);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  get state(): KeySetState {
    if (!this.local || Date.now() - this.loadedAt > this.options.maxStaleMs) return 'unavailable';
    return this.lastRefreshFailed ? 'stale' : 'ok';
  }

  /** The `getKey` callback for jose's jwtVerify. */
  readonly getKey = async (
    header: CompactJWSHeaderParameters,
    token: FlattenedJWSInput,
  ): Promise<CryptoKey> => {
    if (this.state === 'unavailable') {
      await this.refresh();
      if (this.state === 'unavailable') throw identityProviderUnavailable();
    }
    if (header.kid && !this.kids.has(header.kid)) {
      const now = Date.now();
      if (now - this.lastUnknownKidRefresh >= this.options.unknownKidCooldownMs) {
        this.lastUnknownKidRefresh = now;
        await this.refresh();
      }
    }
    return (this.local as JWTVerifyGetKey)(header, token) as Promise<CryptoKey>;
  };

  /** One shared fetch at a time; resolves to whether it succeeded. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async load(): Promise<boolean> {
    try {
      const jwks = parseJwks(await this.fetchJson(this.jwksUri, this.options.timeoutMs));
      this.local = createLocalJWKSet(jwks);
      this.kids = new Set(jwks.keys.map((key) => key.kid).filter((kid): kid is string => !!kid));
      this.loadedAt = Date.now();
      this.lastRefreshFailed = false;
      return true;
    } catch (error) {
      this.lastRefreshFailed = true;
      this.logger.warn(
        `JWKS ${this.jwksUri} not refreshed (keeping the last good keys): ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async coldStart(delayMs: number): Promise<void> {
    if (this.stopped) return;
    if (await this.refresh()) {
      this.schedule();
      return;
    }
    this.timer = setTimeout(
      () => void this.coldStart(Math.min(delayMs * 2, COLD_RETRY_MAX_MS)),
      delayMs,
    );
    this.timer.unref();
  }

  private schedule(): void {
    if (this.stopped) return;
    const jitter = 0.9 + Math.random() * 0.2;
    this.timer = setTimeout(() => {
      void this.refresh().then(() => this.schedule());
    }, this.options.refreshMs * jitter);
    this.timer.unref();
  }
}

/** A JWKS document; a set with duplicate kids is rejected as a whole. */
function parseJwks(value: unknown): JSONWebKeySet {
  const keys = (value as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('not a JWKS (no keys)');
  const kids = keys.map((key) => (key as { kid?: unknown }).kid);
  if (kids.some((kid) => typeof kid !== 'string')) throw new Error('every key needs a kid');
  if (new Set(kids).size !== kids.length) throw new Error('duplicate kids');
  return { keys };
}

async function fetchJwks(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
