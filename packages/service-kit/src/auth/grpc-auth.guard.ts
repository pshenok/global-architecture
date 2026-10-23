import {
  type Actor,
  ANONYMOUS,
  adminRoleRequired,
  isAdmin,
  PermissionDeniedError,
  UnauthenticatedError,
} from '@ga/kernel';
import type { Metadata } from '@grpc/grpc-js';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { type AccessPolicy, accessPolicyOf } from './access.ts';
import {
  actorFromClaims,
  rememberVerifiedCall,
  serviceActorOf,
  type VerifiedCall,
} from './principal-context.ts';
import {
  CALLER_METADATA_KEY,
  PRINCIPAL_METADATA_KEY,
  type PrincipalClaims,
  TokenError,
} from './tokens.ts';
import { WorkloadIdentity } from './workload-identity.ts';

/**
 * Reasons a service gives when the platform itself (not the end user) got authentication
 * wrong: an undeclared policy, a missing or wrong principal, a caller that is not allowed.
 * An edge reports them as 500, so clients never react to a server bug by signing in again.
 */
export const PLATFORM_AUTH_FAULTS: ReadonlySet<string> = new Set([
  'ACCESS_NOT_DECLARED',
  'PRINCIPAL_NOT_REGISTERED',
  'IDENTITY_PRINCIPAL_REQUIRED',
  'CALLER_NOT_ALLOWED',
]);

/** The single metadata value of `key`, or undefined; several values are an attack or a bug. */
function single(
  metadata: Metadata,
  key: string,
  label: 'CALLER' | 'PRINCIPAL',
): string | undefined {
  const values = metadata.get(key);
  if (values.length === 0) return undefined;
  if (values.length > 1 || typeof values[0] !== 'string') {
    throw new UnauthenticatedError(`${label}_INVALID`, `the call carries an invalid ${key}`);
  }
  return values[0];
}

function tokenFailure(error: unknown, label: 'CALLER' | 'PRINCIPAL', key: string): never {
  if (!(error instanceof TokenError)) throw error;
  const reason =
    error.reason === 'expired' ? 'EXPIRED' : error.reason === 'missing' ? 'MISSING' : 'INVALID';
  throw new UnauthenticatedError(`${label}_${reason}`, `${key}: ${error.message}`);
}

/**
 * Authenticates and authorizes every inbound RPC (installed by GrpcPlatformModule;
 * there is no switch to turn it off):
 * 1. the method must declare an @Access policy;
 * 2. the call must carry a caller assertion addressed to this workload;
 * 3. the policy decides what else is needed (a principal, a role, a caller allowlist).
 * Health checks and reflection are not Nest handlers and stay unauthenticated.
 */
@Injectable()
export class GrpcAuthGuard implements CanActivate {
  constructor(private readonly identity: WorkloadIdentity) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Fail closed: services serve gRPC only, any other transport is not authenticated.
    if (context.getType() !== 'rpc') return false;
    const policy = accessPolicyOf(context.getHandler());
    if (!policy) {
      throw new PermissionDeniedError(
        'ACCESS_NOT_DECLARED',
        `${context.getClass().name}.${context.getHandler().name} declares no access policy`,
      );
    }
    const metadata = context.switchToRpc().getContext<Metadata>();
    const caller = await this.identity
      .verifyCaller(single(metadata, CALLER_METADATA_KEY, 'CALLER'))
      .catch((error: unknown) => tokenFailure(error, 'CALLER', CALLER_METADATA_KEY));
    // Remembered before authorizing, so a rejected call is still logged with its caller.
    rememberVerifiedCall(metadata, { caller, actor: ANONYMOUS });
    rememberVerifiedCall(metadata, await this.authorize(policy, caller, metadata));
    return true;
  }

  private async authorize(
    policy: AccessPolicy,
    caller: string,
    metadata: Metadata,
  ): Promise<VerifiedCall> {
    if (policy.kind === 'public') return { caller, actor: ANONYMOUS };
    if (policy.kind === 'service') {
      if (!policy.callers.includes(caller)) throw callerNotAllowed(caller);
      return { caller, actor: serviceActorOf(caller) };
    }
    if (!this.identity.principalIssuers.includes(caller) && !policy.via.includes(caller)) {
      throw callerNotAllowed(caller);
    }
    const token = single(metadata, PRINCIPAL_METADATA_KEY, 'PRINCIPAL');
    const claims: PrincipalClaims = await this.identity
      .verifyPrincipal(token)
      .catch((error: unknown) => tokenFailure(error, 'PRINCIPAL', PRINCIPAL_METADATA_KEY));
    const actor: Actor = actorFromClaims(claims);
    if (policy.kind === 'identity') {
      if (actor.kind !== 'identity') {
        throw new PermissionDeniedError(
          'IDENTITY_PRINCIPAL_REQUIRED',
          'this method is for unregistered identities',
        );
      }
    } else {
      if (actor.kind !== 'user') {
        throw new PermissionDeniedError(
          'PRINCIPAL_NOT_REGISTERED',
          'this method requires a registered user',
        );
      }
      if (policy.kind === 'admin' && !isAdmin(actor)) throw adminRoleRequired();
    }
    return { caller, actor, principalToken: token };
  }
}

const callerNotAllowed = (caller: string) =>
  new PermissionDeniedError('CALLER_NOT_ALLOWED', `workload ${caller} may not call this method`, {
    caller,
  });
