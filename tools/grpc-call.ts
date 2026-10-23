/**
 * Calls one RPC of a running local service, the way the platform would (ADR-0004):
 * over TLS, with a caller assertion signed by a local workload key and, when asked,
 * a principal signed by the gateway's key.
 *
 *   pnpm grpc:call house-service ListHouses '{"pageSize":5}'
 *   pnpm grpc:call booking-service ListBookings '{"party":"BOOKING_PARTY_HOST"}' --as <userId>
 *   pnpm grpc:call user-service ListUsers '{}' --as <userId> --admin
 *   pnpm grpc:call user-service ResolveIdentity '{}' --identity alice
 *   options: --caller <workload> (default gateway)
 *
 * Local only: it signs with the keys in .certs/ and refuses production.
 */
import { parseArgs } from 'node:util';
import type { PrincipalClaims } from '@ga/service-kit';
import {
  CALLER_METADATA_KEY,
  createGrpcTestClient,
  grpcError,
  PRINCIPAL_METADATA_KEY,
  readSigningKey,
  signCallerToken,
  signPrincipalToken,
} from '@ga/service-kit/testing';
import { Metadata } from '@grpc/grpc-js';
import { CERTS_DIR, readRegistry, workloadKeyPath } from './lib.ts';

if (process.env.NODE_ENV === 'production') {
  console.error('grpc:call signs with local development keys; it never runs in production');
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    caller: { type: 'string', default: 'gateway' },
    as: { type: 'string' },
    admin: { type: 'boolean', default: false },
    identity: { type: 'string' },
  },
});
const [serviceName, method, json = '{}'] = positionals;
const registry = readRegistry();
const service = registry.services.find((s) => s.name === serviceName);
if (!service || !method) {
  console.error(
    `usage: pnpm grpc:call <service> <Method> ['<json>'] [--as <userId> [--admin] | --identity <sub>] [--caller <workload>]\nservices: ${registry.services.map((s) => s.name).join(', ')}`,
  );
  process.exit(1);
}

const metadata = new Metadata();
const caller = values.caller as string;
metadata.set(
  CALLER_METADATA_KEY,
  await signCallerToken(await readSigningKey(workloadKeyPath(caller)), caller, service.name),
);
const gateway = registry.gateway.name;
if (values.as || values.identity) {
  const claims: PrincipalClaims = values.as
    ? { kind: 'user', userId: values.as, roles: values.admin ? ['admin'] : [] }
    : {
        kind: 'identity',
        issuer: `http://127.0.0.1:${registry.devIdp.port}`,
        subject: values.identity as string,
        email: null,
      };
  metadata.set(
    PRINCIPAL_METADATA_KEY,
    await signPrincipalToken(await readSigningKey(workloadKeyPath(gateway)), gateway, claims, 60),
  );
}

type Call = (request: unknown, metadata: Metadata) => Promise<unknown>;
const client = createGrpcTestClient<unknown>(
  service.grpcService,
  [service.protoFile],
  `localhost:${service.grpcPort}`,
  { caFile: `${CERTS_DIR}/grpc-ca.pem` },
);
const call = (client as unknown as Record<string, Call | undefined>)[
  method.charAt(0).toLowerCase() + method.slice(1)
];
if (!call) {
  console.error(`${service.grpcService} has no method ${method}`);
  process.exit(1);
}
try {
  const response = await call(JSON.parse(json), metadata).catch(async (error: unknown) => {
    const failure = await grpcError(Promise.reject(error as Error));
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
    return undefined;
  });
  if (response !== undefined) console.log(JSON.stringify(response, null, 2));
} finally {
  client.close();
}
