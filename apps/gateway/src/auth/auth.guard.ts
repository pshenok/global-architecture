import { DependencyUnavailableError, PermissionDeniedError } from '@ga/kernel';
import { enterPrincipal, InjectConfig, WorkloadIdentity } from '@ga/service-kit';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AccessTokenVerifier, bearerToken, tokenMissing } from './access-token-verifier.ts';
import type { AuthConfig } from './auth.config.ts';
import { AuthRoutes } from './auth-routes.ts';
import { acceptedEmail } from './email-claims.ts';
import { IdentityResolver } from './identity-resolver.ts';

export const userNotRegistered = () =>
  new PermissionDeniedError(
    'USER_NOT_REGISTERED',
    'this login has no user yet: register with POST /v1/users',
  );

/**
 * Authenticates every HTTP request (ADR-0004). Routes need a registered user unless
 * they are @Public() or @AllowUnregistered(), as recorded at boot (AuthRoutes). On
 * success the request gets a principal signed by the gateway, which the gRPC clients
 * forward to the services.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly routes: AuthRoutes,
    private readonly verifier: AccessTokenVerifier,
    private readonly resolver: IdentityResolver,
    private readonly identity: WorkloadIdentity,
    @InjectConfig() private readonly config: AuthConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Fail closed: the gateway serves HTTP only, any other transport is not authenticated.
    if (context.getType() !== 'http') return false;
    const route = this.routes.routeOf(context.getClass(), context.getHandler());
    if (route === 'unknown') {
      // A server bug (500), never something a client can fix by signing in.
      throw new Error(
        `${context.getClass().name}.${context.getHandler().name} was not a route when the gateway started`,
      );
    }
    if (route?.mode === 'public' && route.ignoreToken) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = bearerToken(request.headers.authorization);

    if (route?.mode === 'public') {
      // A token that is sent must be valid; it is not used for anything else, so an
      // identity-provider outage does not take public routes down with it.
      if (token) {
        await this.verifier.verify(token).catch((error: unknown) => {
          if (!(error instanceof DependencyUnavailableError)) throw error;
        });
      }
      return true;
    }
    if (!token) throw tokenMissing();
    const verified = await this.verifier.verify(token);
    const ttl = this.config.PRINCIPAL_TOKEN_TTL_S;

    if (route?.mode === 'unregistered') {
      const email = await acceptedEmail(verified);
      enterPrincipal(
        await this.identity.issuePrincipal(
          { kind: 'identity', issuer: verified.issuer.issuer, subject: verified.subject, email },
          ttl,
        ),
      );
      return true;
    }
    const user = await this.resolver.resolve({
      issuer: verified.issuer.issuer,
      subject: verified.subject,
    });
    if (!user) throw userNotRegistered();
    enterPrincipal(
      await this.identity.issuePrincipal(
        { kind: 'user', userId: user.userId, roles: user.roles },
        ttl,
      ),
    );
    return true;
  }
}
