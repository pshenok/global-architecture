import {
  type Actor,
  ANONYMOUS,
  type IdentityActor,
  type ServiceActor,
  UnauthenticatedError,
  type UserActor,
} from '@ga/kernel';
import type { ExecutionContext } from '@nestjs/common';
import { type ClsService, ClsServiceManager } from 'nestjs-cls';
import type { PrincipalClaims } from './tokens.ts';

/** What the auth guard established about one inbound call. */
export interface VerifiedCall {
  /** Workload that made the call (from its verified caller assertion). */
  readonly caller: string;
  readonly actor: Actor;
  /** The principal as received; outbound calls forward it unchanged. */
  readonly principalToken?: string | undefined;
}

/**
 * Guards run before interceptors, so the guard cannot write CLS yet: it keys its result
 * on the call's Metadata object (the key nestjs-cls itself uses for RPC contexts), and
 * the CLS interceptor's setup copies it over.
 */
const verifiedCalls = new WeakMap<object, VerifiedCall>();

export function rememberVerifiedCall(metadata: object, call: VerifiedCall): void {
  verifiedCalls.set(metadata, call);
}

/** The verified call of an RPC context; for guards and loggers, which run outside CLS. */
export function principalFrom(context: ExecutionContext): VerifiedCall | undefined {
  if (context.getType() !== 'rpc') return undefined;
  const metadata = context.switchToRpc().getContext<unknown>();
  return metadata !== null && typeof metadata === 'object'
    ? verifiedCalls.get(metadata)
    : undefined;
}

const CLS_ACTOR = 'ga.auth.actor';
const CLS_CALLER = 'ga.auth.caller';
const CLS_PRINCIPAL_TOKEN = 'ga.auth.principalToken';

/** Copies a verified call into the request context. Never throws (CLS setup must not). */
export function enterVerifiedCall(cls: ClsService, call: VerifiedCall | undefined): void {
  if (!call) return;
  cls.set(CLS_ACTOR, call.actor);
  cls.set(CLS_CALLER, call.caller);
  if (call.principalToken) cls.set(CLS_PRINCIPAL_TOKEN, call.principalToken);
}

function activeCls(): ClsService | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    return cls.isActive() ? cls : undefined;
  } catch {
    return undefined;
  }
}

/** A principal this edge signed; only `WorkloadIdentity.issuePrincipal` makes one. */
export interface IssuedPrincipal {
  readonly token: string;
  readonly actor: UserActor | IdentityActor;
}

const issuedPrincipals = new WeakSet<IssuedPrincipal>();

/** For WorkloadIdentity.issuePrincipal only; not exported from the package. */
export function issuedPrincipal(token: string, actor: UserActor | IdentityActor): IssuedPrincipal {
  const principal = Object.freeze({ token, actor });
  issuedPrincipals.add(principal);
  return principal;
}

/**
 * For edges (the gateway): makes `principal` the current request's actor and the
 * principal forwarded on every outbound call. Takes only what
 * `WorkloadIdentity.issuePrincipal` returned (edge workloads only), so it cannot be
 * used to put a hand-made actor into a request.
 */
export function enterPrincipal(principal: IssuedPrincipal): void {
  if (!issuedPrincipals.has(principal)) {
    throw new Error('enterPrincipal takes only a principal from WorkloadIdentity.issuePrincipal');
  }
  const cls = activeCls();
  if (!cls) throw new Error('enterPrincipal needs an active request context (CLS)');
  cls.set(CLS_ACTOR, principal.actor);
  cls.set(CLS_PRINCIPAL_TOKEN, principal.token);
}

/** The actor of the current request; anonymous outside a request or on public methods. */
export function currentActor(): Actor {
  return (activeCls()?.get(CLS_ACTOR) as Actor | undefined) ?? ANONYMOUS;
}

/** The registered user of the current request. Throws UNAUTHENTICATED when there is none. */
export function currentUser(): UserActor {
  const actor = currentActor();
  if (actor.kind !== 'user') {
    throw new UnauthenticatedError('AUTHENTICATION_REQUIRED', 'this operation requires a user');
  }
  return actor;
}

/** The IdP identity of the current request (registration). Throws UNAUTHENTICATED otherwise. */
export function currentIdentity(): IdentityActor {
  const actor = currentActor();
  if (actor.kind !== 'identity') {
    throw new UnauthenticatedError('IDENTITY_REQUIRED', 'this operation requires an identity');
  }
  return actor;
}

/** The workload that called the current RPC, if any. */
export function currentCaller(): string | undefined {
  return activeCls()?.get(CLS_CALLER) as string | undefined;
}

/** The principal to forward on outbound calls, if the current request has one. */
export function currentPrincipalToken(): string | undefined {
  return activeCls()?.get(CLS_PRINCIPAL_TOKEN) as string | undefined;
}

/**
 * The only place verified actors are minted: from claims the kit verified or signed.
 * Not exported from the package.
 */
export function actorFromClaims(claims: PrincipalClaims): UserActor | IdentityActor {
  return claims.kind === 'user'
    ? (Object.freeze({
        kind: 'user',
        userId: claims.userId,
        roles: Object.freeze([...claims.roles]),
      }) as UserActor)
    : (Object.freeze({
        kind: 'identity',
        issuer: claims.issuer,
        subject: claims.subject,
        email: claims.email,
      }) as IdentityActor);
}

export function serviceActorOf(name: string): ServiceActor {
  return Object.freeze({ kind: 'service', name }) as ServiceActor;
}
