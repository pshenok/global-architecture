# ADR-0003: API and error conventions

- Status: Accepted
- Date: 2026-10-22

## Context

Callers (other services, the gateway, external clients) need to branch on failures
reliably, and the legacy boilerplate returned `UNKNOWN` for every error.

## Decision

**gRPC (internal)**: a pragmatic subset of Google AIPs, enforced by buf STANDARD lint:
versioned packages `ga.<domain>.v1`; request/response wrappers per RPC; `page_size` /
`page_token` / `next_page_token` keyset pagination; `google.protobuf.Timestamp`;
partial updates with proto3 `optional` fields (not FieldMask, for type safety);
every RPC documents its status codes.

**Errors**: business failures are `DomainError` subclasses with a stable UPPER_SNAKE
`reason`. The service kit maps the kind to a gRPC status and attaches `google.rpc.Status`
details (`ErrorInfo` with reason, domain = service name, metadata; `BadRequest` with field
violations) in `grpc-status-details-bin`. Unknown errors become `INTERNAL` with a generic
message. Domain error messages and metadata are client-facing by contract.

| Kind                       | gRPC                | HTTP |
| -------------------------- | ------------------- | ---- |
| ValidationError            | INVALID_ARGUMENT    | 400  |
| NotFoundError              | NOT_FOUND           | 404  |
| ConflictError              | ALREADY_EXISTS      | 409  |
| PreconditionFailedError    | FAILED_PRECONDITION | 400  |
| ConcurrencyError           | ABORTED             | 409  |
| PermissionDeniedError      | PERMISSION_DENIED   | 403  |
| UnauthenticatedError       | UNAUTHENTICATED     | 401  |
| RateLimitedError           | RESOURCE_EXHAUSTED  | 429  |
| DependencyUnavailableError | UNAVAILABLE         | 503  |
| (deadline)                 | DEADLINE_EXCEEDED   | 504  |
| (unexpected)               | INTERNAL            | 500  |

**REST (public)**: versioned paths (`/v1`), plural resources, camelCase JSON, ISO-8601
times, `{ items, nextPageToken }` lists, 201 + `Location` on create, 204 on delete,
custom actions as `POST /v1/<resources>/{id}/<verb>`. Every error is RFC 9457
`application/problem+json` with `code` (the reason), optional `domain`, `metadata`,
`errors[]` and `requestId`; `detail` is omitted for 5xx.

## Consequences

Clients branch on `code`, never on messages. Changing an existing reason is a breaking
change. Standard gRPC tooling (buf curl, grpcurl, Connect) decodes the error details.
