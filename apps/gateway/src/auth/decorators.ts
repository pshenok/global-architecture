import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

/** How a route authenticates. Routes are `user` (a registered user) unless decorated. */
export type AuthRoute =
  | { readonly mode: 'public'; readonly reason: string }
  | { readonly mode: 'unregistered' };

export const AUTH_ROUTE = 'ga:auth-route';

/** OpenAPI extension that marks an operation as not needing a token (removed from the document). */
export const PUBLIC_EXTENSION = 'x-ga-public';

/**
 * Anyone may call this route. A token that is sent is still verified (a bad one is a
 * 401, never a silent downgrade), but it is neither resolved nor forwarded: services
 * see an anonymous call. Every public route is listed in security/public-endpoints.json.
 */
export const Public = (reason: string) => {
  if (!reason.trim()) throw new TypeError('@Public needs a reason');
  return applyDecorators(
    SetMetadata(AUTH_ROUTE, { mode: 'public', reason } satisfies AuthRoute),
    ApiExtension(PUBLIC_EXTENSION, true),
  );
};

/** A verified login that has no user yet may call this route (registration only). */
export const AllowUnregistered = () =>
  SetMetadata(AUTH_ROUTE, { mode: 'unregistered' } satisfies AuthRoute);
