import { describe, expect, it } from 'vitest';
import { defineService } from '../platform/service-definition.ts';
import { databaseConfigSchema, grpcServiceConfigSchema, parseConfig } from './config.ts';

describe('parseConfig', () => {
  const schema = grpcServiceConfigSchema.extend(databaseConfigSchema.shape);

  it('applies defaults and coerces numbers and booleans', () => {
    const config = parseConfig(schema, {
      GRPC_PORT: '50051',
      DATABASE_URL: 'postgresql://ga:ga@localhost:5432/ga_user',
      LOG_PRETTY: 'true',
      WORKLOAD_KEY_FILE: '/keys/user-service.jwk.json',
      WORKLOAD_KEYS_FILE: '/keys/workload-keys.json',
      PRINCIPAL_ISSUERS: 'gateway, partner-edge',
    });
    expect(config).toMatchObject({
      GRPC_PORT: 50051,
      GRPC_HOST: '127.0.0.1',
      LOG_PRETTY: true,
      DB_POOL_MAX: 10,
      WORKLOAD_KEYS_RELOAD_S: 60,
      PRINCIPAL_ISSUERS: ['gateway', 'partner-edge'],
    });
  });

  it('reports every invalid variable at once', () => {
    const problems = () => parseConfig(schema, { GRPC_PORT: 'abc', DATABASE_URL: 'mysql://x' });
    for (const variable of ['GRPC_PORT', 'DATABASE_URL', 'WORKLOAD_KEY_FILE']) {
      expect(problems).toThrow(variable);
    }
  });
});

describe('defineService', () => {
  it('accepts a consistent definition', () => {
    expect(
      defineService({
        name: 'user-service',
        protoFiles: ['ga/user/v1/user.proto'],
        packages: ['ga.user.v1'],
        services: ['ga.user.v1.UserService'],
      }).services,
    ).toEqual(['ga.user.v1.UserService']);
  });

  it('rejects unversioned or foreign services', () => {
    const base = { name: 'user-service', protoFiles: [], packages: ['ga.user.v1'] };
    expect(() => defineService({ ...base, services: ['ga.user.UserService'] })).toThrow(
      /versioned/,
    );
    expect(() => defineService({ ...base, services: ['ga.house.v1.HouseService'] })).toThrow(
      /package/,
    );
    expect(() => defineService({ ...base, name: 'UserService', services: [] })).toThrow(/kebab/);
  });
});
