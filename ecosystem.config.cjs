// PM2 definition of the local stack, generated from services.json.
// CommonJS on purpose: PM2 require()s this file.
//   pnpm stack:up      build, migrate, start everything, wait until ready
//   pnpm stack:status  pnpm stack:logs   pnpm stack:down
const registry = require('./services.json');

const DB_URL = (database) => `postgresql://ga:ga@localhost:5432/${database}`;
const CERTS = `${__dirname}/.certs`;

/** gRPC TLS between workloads (tools/dev-certs.ts): services serve it, everyone verifies it. */
/** Workload identity (tools/dev-keys.ts): each app signs with its own key, trusts the map. */
const workloadKeys = (name) => ({
  WORKLOAD_KEY_FILE: `${CERTS}/workloads/${name}.jwk.json`,
  WORKLOAD_KEYS_FILE: `${CERTS}/workload-keys.json`,
});

/** The local OIDC provider (tools/dev-idp.ts) the gateway trusts; dev only. */
const devIdp = `http://127.0.0.1:${registry.devIdp.port}`;
const AUTH_ISSUERS = JSON.stringify([
  {
    issuer: devIdp,
    audience: 'ga-api',
    jwksUri: `${devIdp}/jwks.json`,
    userinfoUri: `${devIdp}/userinfo`,
  },
]);

const grpcServerTls = {
  GRPC_TLS_CERT_FILE: `${CERTS}/grpc-server.pem`,
  GRPC_TLS_KEY_FILE: `${CERTS}/grpc-server-key.pem`,
  GRPC_TLS_CA_FILE: `${CERTS}/grpc-ca.pem`,
};

/** Every service address (a host name: TLS certificates name hosts, not IPs). */
const serviceUrls = Object.fromEntries(
  registry.services.map((s) => [s.urlEnv, `localhost:${s.grpcPort}`]),
);

const common = {
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  max_restarts: 10,
  min_uptime: 5000,
  kill_timeout: 15000,
  merge_logs: true,
  time: false,
  // The repo's pinned Node (devEngines.runtime, linked by pnpm), not whatever is on PATH.
  // (The symlink path matters: PM2 treats an "@" in the interpreter path as an nvm version.)
  interpreter: `${__dirname}/node_modules/.bin/node`,
  node_args: [
    '--enable-source-maps',
    '--env-file-if-exists=.env',
    '--import',
    '@ga/service-kit/telemetry',
  ],
};

module.exports = {
  apps: [
    ...registry.services.map((service) => ({
      ...common,
      name: service.name,
      cwd: `${__dirname}/${service.dir}`,
      script: 'dist/main.js',
      env: {
        NODE_ENV: 'development',
        LOG_PRETTY: 'false',
        GRPC_HOST: '127.0.0.1',
        GRPC_PORT: String(service.grpcPort),
        DATABASE_URL: DB_URL(service.database),
        OTEL_SERVICE_NAME: service.name,
        ...grpcServerTls,
        ...workloadKeys(service.name),
        ...serviceUrls,
      },
    })),
    {
      ...common,
      name: registry.gateway.name,
      cwd: `${__dirname}/${registry.gateway.dir}`,
      script: 'dist/main.js',
      env: {
        NODE_ENV: 'development',
        LOG_PRETTY: 'false',
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(registry.gateway.httpsPort),
        TLS_ENABLED: 'true',
        TLS_CERT_FILE: `${CERTS}/dev-cert.pem`,
        TLS_KEY_FILE: `${CERTS}/dev-key.pem`,
        GRPC_TLS_CA_FILE: grpcServerTls.GRPC_TLS_CA_FILE,
        ...workloadKeys(registry.gateway.name),
        AUTH_ISSUERS,
        // Rotation tests rotate the dev IdP's key and use the new one right away.
        AUTH_JWKS_UNKNOWN_KID_COOLDOWN_S: '1',
        OTEL_SERVICE_NAME: 'gateway',
        ...serviceUrls,
      },
    },
    {
      ...common,
      name: 'dev-idp',
      cwd: __dirname,
      script: 'tools/dev-idp.ts',
      node_args: ['--enable-source-maps'],
      env: { NODE_ENV: 'development' },
    },
  ],
};
