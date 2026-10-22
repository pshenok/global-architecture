# ADR-0004: Identity and authorization

- Status: Proposed (not implemented)
- Date: 2026-10-22

## Context

Today every endpoint is anonymous: any caller can update or delete any user, house or
booking, and list all bookings. This is acceptable only for local development, which is
why processes bind to 127.0.0.1 by default (`GRPC_HOST`, `GATEWAY_HOST`); container images
opt into `0.0.0.0` explicitly.

## Proposal

1. **Authentication at the edge.** The gateway verifies an OIDC access token (JWT,
   verified against the provider's JWKS; issuer, audience and expiry checked) in a global
   guard. Public routes are explicit (`@Public()`). The identity provider (Keycloak, Auth0,
   Cognito, Zitadel, ...) is an open decision.
2. **Principal propagation.** The gateway forwards the verified principal to services in
   gRPC metadata (`x-principal-id`, `x-principal-roles`), signed or protected by mTLS
   between workloads, so services never trust it from an arbitrary caller.
3. **Authorization in the service that owns the data.** The service kit exposes
   `currentPrincipal()` (from CLS); use cases enforce ownership rules
   (only the owner updates a house, only the guest or the owner cancels a booking, lists
   are scoped to the caller) and throw `PermissionDeniedError` / `UnauthenticatedError`.
4. **Service-to-service identity** through mTLS (service mesh or SPIFFE) once deployed.

## Consequences

Every list endpoint must define its scoping rule before it is exposed publicly. Tests
gain a principal fixture. The REST contract gains 401/403 responses.
