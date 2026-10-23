// PM2 definition of the local stack, generated from services.json.
// CommonJS on purpose: PM2 require()s this file.
//   pnpm stack:up      build, migrate, start everything, wait until ready
//   pnpm stack:status  pnpm stack:logs   pnpm stack:down
const registry = require('./services.json');

const DB_URL = (database) => `postgresql://ga:ga@localhost:5432/${database}`;
const CERTS = `${__dirname}/.certs`;

/** gRPC TLS between workloads (tools/dev-certs.ts): services serve it, everyone verifies it. */
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
        OTEL_SERVICE_NAME: 'gateway',
        ...serviceUrls,
      },
    },
  ],
};
