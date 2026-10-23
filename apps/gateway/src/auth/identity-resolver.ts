import type { UserServiceClient } from '@ga/contracts/ga/user/v1/user';
import { ROLES, type Role } from '@ga/kernel';
import {
  enterPrincipal,
  grpcStatusOf,
  InjectConfig,
  toDependencyError,
  WorkloadIdentity,
} from '@ga/service-kit';
import { status } from '@grpc/grpc-js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { USER_SERVICE } from '../clients.ts';
import type { AuthConfig } from './auth.config.ts';

export interface Identity {
  readonly issuer: string;
  readonly subject: string;
}

export interface ResolvedUser {
  readonly userId: string;
  readonly roles: readonly Role[];
}

/** Maps a verified identity-provider login to its platform user. */
export abstract class IdentityResolver {
  /** The user of `identity`, or null when it has none. Throws DependencyUnavailableError. */
  abstract resolve(identity: Identity): Promise<ResolvedUser | null>;
  /** Drops a cached "not registered" answer (after this gateway registered the identity). */
  abstract forget(identity: Identity): void;
}

interface Entry {
  readonly user: ResolvedUser | null;
  readonly at: number;
}

/**
 * Resolves through user-service.ResolveIdentity with a small LRU cache, so a request
 * does not cost a lookup: answers are fresh for IDENTITY_CACHE_TTL_S, "not registered"
 * for IDENTITY_CACHE_NEGATIVE_TTL_S, and while user-service is unreachable a known
 * mapping keeps serving for IDENTITY_CACHE_STALE_IF_ERROR_S (role changes and
 * deletions therefore take up to the TTL, or the stale window during an outage).
 */
@Injectable()
export class GrpcIdentityResolver extends IdentityResolver {
  private readonly logger = new Logger(GrpcIdentityResolver.name);
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<ResolvedUser | null>>();

  constructor(
    @Inject(USER_SERVICE) private readonly users: UserServiceClient,
    private readonly identity: WorkloadIdentity,
    private readonly cls: ClsService,
    @InjectConfig() private readonly config: AuthConfig,
  ) {
    super();
  }

  async resolve(identity: Identity): Promise<ResolvedUser | null> {
    const key = `${identity.issuer}\n${identity.subject}`;
    const cached = this.cache.get(key);
    if (cached) {
      const ttl = cached.user
        ? this.config.IDENTITY_CACHE_TTL_S
        : this.config.IDENTITY_CACHE_NEGATIVE_TTL_S;
      if (Date.now() - cached.at < ttl * 1_000) {
        this.touch(key, cached);
        return cached.user;
      }
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetch(identity).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    try {
      const user = await pending;
      this.touch(key, { user, at: Date.now() });
      return user;
    } catch (error) {
      const staleFor = cached?.user ? Date.now() - cached.at : Number.POSITIVE_INFINITY;
      if (staleFor < this.config.IDENTITY_CACHE_STALE_IF_ERROR_S * 1_000) {
        this.logger.warn(
          `user-service unreachable, serving a cached identity (${Math.round(staleFor / 1_000)} s old)`,
        );
        return cached?.user ?? null;
      }
      throw error;
    }
  }

  forget(identity: Identity): void {
    this.cache.delete(`${identity.issuer}\n${identity.subject}`);
  }

  /** Asks user-service as the identity itself, in a child context so the request's own principal is untouched. */
  private fetch(identity: Identity): Promise<ResolvedUser | null> {
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      enterPrincipal(
        await this.identity.issuePrincipal(
          { kind: 'identity', issuer: identity.issuer, subject: identity.subject, email: null },
          this.config.PRINCIPAL_TOKEN_TTL_S,
        ),
      );
      try {
        const { userId, roles } = await firstValueFrom(this.users.resolveIdentity({}));
        return {
          userId,
          roles: roles.filter((role): role is Role => (ROLES as readonly string[]).includes(role)),
        };
      } catch (error) {
        if (grpcStatusOf(error) === status.NOT_FOUND) return null;
        throw toDependencyError(error, 'user-service');
      }
    });
  }

  private touch(key: string, entry: Entry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > this.config.IDENTITY_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
