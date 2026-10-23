import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REGISTRY_PATH = `${ROOT}services.json`;

export interface ServiceEntry {
  /** e.g. `house-service` */
  name: string;
  /** e.g. `apps/house-service` */
  dir: string;
  /** e.g. `@ga/house-service` */
  package: string;
  grpcPort: number;
  /** e.g. `ga_house` */
  database: string;
  /** e.g. `ga.house.v1.HouseService` */
  grpcService: string;
  /** e.g. `ga/house/v1/house.proto` */
  protoFile: string;
  /** Env var other services and the gateway use to reach it, e.g. `HOUSE_SERVICE_URL`. */
  urlEnv: string;
  /** Postgres extensions its migrations need (pre-created by `pnpm db:setup`), e.g. `btree_gist`. */
  extensions?: string[];
}

export interface Registry {
  $comment: string;
  gateway: { name: string; dir: string; httpsPort: number };
  /** Local OIDC provider of the stack (tools/dev-idp.ts). */
  devIdp: { port: number };
  services: ServiceEntry[];
}

export function readRegistry(): Registry {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
}

export function writeRegistry(registry: Registry): void {
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

/** Connection URL the local stack uses for a service database (role ga, see db:setup). */
export function databaseUrl(database: string): string {
  return `postgresql://ga:ga@localhost:5432/${database}`;
}

export const DEFAULT_PG_ADMIN_URL = `postgresql://${process.env.USER ?? 'postgres'}@localhost:5432/postgres`;
export const TEST_DATABASE = 'ga_test';

/** Local secrets and certificates (git-ignored). */
export const CERTS_DIR = `${ROOT}.certs`;
/** Public keys of every workload (WORKLOAD_KEYS_FILE). */
export const WORKLOAD_KEYS_PATH = `${CERTS_DIR}/workload-keys.json`;
/** Private key of one workload (its WORKLOAD_KEY_FILE). */
export const workloadKeyPath = (name: string) => `${CERTS_DIR}/workloads/${name}.jwk.json`;
/** Every workload with an identity: the gateway plus the registered services. */
export function workloadNames(registry: Registry = readRegistry()): string[] {
  return [registry.gateway.name, ...registry.services.map((service) => service.name)];
}
