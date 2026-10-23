import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

/** How a route authenticates. Routes are `user` (a registered user) unless decorated. */
export type AuthRoute =
  | { readonly mode: 'public'; readonly reason: string; readonly ignoreToken: boolean }
  | { readonly mode: 'unregistered' };

export const AUTH_ROUTE = 'ga:auth-route';

/** OpenAPI extension that marks an operation as not needing a token (removed from the document). */
export const PUBLIC_EXTENSION = 'x-ga-public';

export interface PublicOptions {
  /**
   * Do not even look at an Authorization header (health probes: they must answer the
   * same with or without one, and cost no crypto on an unthrottled route).
   */
  readonly ignoreToken?: boolean;
}

/**
 * Anyone may call this route. A token that is sent is still verified (a bad one is a
 * 401, never a silent downgrade) unless the identity provider is unavailable, but it
 * is neither resolved nor forwarded: services see an anonymous call. Every public
 * route is listed in security/public-endpoints.json.
 */
export const Public = (reason: string, options: PublicOptions = {}) => {
  if (!reason.trim()) throw new TypeError('@Public needs a reason');
  const route: AuthRoute = { mode: 'public', reason, ignoreToken: options.ignoreToken ?? false };
  return applyDecorators(SetMetadata(AUTH_ROUTE, route), ApiExtension(PUBLIC_EXTENSION, true));
};

/** A verified login that has no user yet may call this route (registration only). */
export const AllowUnregistered = () =>
  SetMetadata(AUTH_ROUTE, { mode: 'unregistered' } satisfies AuthRoute);
