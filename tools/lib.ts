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
}

export interface Registry {
  $comment: string;
  gateway: { name: string; dir: string; httpsPort: number };
  services: ServiceEntry[];
}

export function readRegistry(): Registry {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
}

export function writeRegistry(registry: Registry): void {
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

export const DEFAULT_PG_ADMIN_URL = `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`;
export const TEST_DATABASE = 'ga_test';
