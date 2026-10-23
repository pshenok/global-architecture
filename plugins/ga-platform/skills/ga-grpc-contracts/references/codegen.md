# Code generation internals

`pnpm --filter @ga/contracts codegen` runs:
1. `buf lint`: STANDARD rules; vendored `proto/grpc/**` (health) and `proto/google/**`
   (google.rpc error model) are ignored.
2. `buf generate`: local plugin `protoc-gen-ts_proto` from `node_modules`, options in
   `buf.gen.yaml`:
   - `nestJs=true`: interfaces, `XServiceClient`, `XServiceController` and the
     `@XServiceControllerMethods()` decorator; no encode/decode code (proto-loader does that).
   - `useNestjsFqnServiceName=true`: handlers register as `ga.user.v1.UserService`, so two
     packages can both have a `UserService`.
   - `useDate=true`, `stringEnums=true`, `useOptionals=messages`, `useNullAsOptional=true`,
     `forceLong=number`: chosen to match the proto-loader runtime exactly.
   - `importSuffix=.js`: Node ESM.
3. `scripts/postgen.ts`, which fixes two ts-proto outputs that break under Node ESM:
   - removes `import { wrappers } from "protobufjs"` and the Timestamp wrapper block
     (protobufjs is CommonJS, the named import crashes; the runtime installs correct
     wrappers in `src/runtime/wkt.ts` instead);
   - rewrites imports of interfaces from sibling generated files to `import type`
     (otherwise Node fails with "does not provide an export named Money").
4. `buf build -o descriptors.binpb`: real FileDescriptorProtos for server reflection
   (proto-loader's synthesized descriptors break `buf curl` and `grpcurl`).

Every package build ends with `node ../../tools/check-esm.ts`, which imports each built
module with real Node ESM linking. Vitest does not validate named imports, so this is
the guard that catches a type imported as a value.

## Runtime helpers (`@ga/contracts/runtime`)

| Export                                                              | Purpose                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `loadProtoPackage(files)`                                           | proto-loader with the platform options; pass as Nest `packageDefinition` |
| `GRPC_LOADER_OPTIONS`, `PROTO_ROOT`                                 | the options and the proto root                                           |
| `installWellKnownTypes()`                                           | Timestamp <-> Date, FieldMask <-> string[] on proto-loader's protobufjs  |
| `encodeStatusDetails` / `decodeStatusDetails`, `STATUS_DETAILS_KEY` | google.rpc.Status trailer                                                |
| `reflectionPackageDefinition()`                                     | buf-image descriptors for @grpc/reflection                               |

## Version pinning that matters

`pnpm-workspace.yaml` overrides `@grpc/proto-loader` and `protobufjs` to single versions.
Nest loads proto-loader from its own location; without the override it can pick a
different copy than the one the wrappers were installed on, and Timestamps silently
break again.

## Debugging a contract at runtime

Services serve gRPC over TLS in the local stack, with certificates from a local CA
(`.certs/grpc-ca.pem` at the repo root, created by `pnpm certs`). Use
`https://localhost:<port>` (a host name the certificate names) and the CA. Reflection and
health checks are not RPC handlers, so they need no tokens:

```bash
cd packages/contracts
pnpm exec buf curl --protocol grpc --cacert ../../.certs/grpc-ca.pem https://localhost:50051 --list-methods
pnpm exec buf curl --protocol grpc --cacert ../../.certs/grpc-ca.pem -d '{"service":""}' \
  https://localhost:50051/grpc.health.v1.Health/Check
```

Every RPC needs a caller assertion signed by a workload key (and a principal for user
methods), which buf curl cannot produce: it gets `UNAUTHENTICATED` with reason
`CALLER_MISSING`. Call RPCs with `pnpm grpc:call` from the repo root; it signs both with
the local keys in `.certs/` and prints decoded errors:

```bash
pnpm grpc:call house-service ListHouses '{"pageSize":5}'
pnpm grpc:call user-service GetUser '{"id":"<userId>"}' --as <userId>
```

Reflection is on in every service except with `NODE_ENV=production` (unless
`GRPC_REFLECTION=true`), so no local proto files are needed. grpcurl and Postman work the
same way with the CA.
