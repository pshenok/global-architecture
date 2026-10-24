import { fileURLToPath } from 'node:url';
import {
  createTestDatabase,
  startTestService,
  type TestDatabase,
  type TestService,
} from '@ga/service-kit/testing';
import { afterAll, beforeAll } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { EventBroker } from '../src/application/ports/event-broker.ts';
import { EventBrokerAdmin } from '../src/application/ports/event-broker-admin.ts';
import { SERVICE } from '../src/service.ts';
import { describeEventBroker } from './event-broker.contract.ts';
import { describeEventBrokerAdmin } from './event-broker-admin.contract.ts';

let db: TestDatabase;
let service: TestService;

beforeAll(async () => {
  db = await createTestDatabase({
    migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  });
  service = await startTestService({
    module: AppModule,
    service: SERVICE,
    env: { DATABASE_URL: db.url, EVENT_BUS_MAX_ATTEMPTS: '3' },
  });
});

afterAll(async () => {
  await service?.close();
  await db?.dispose();
});

const reset = () => db.truncate('deliveries', 'events');

/** The default backend against real Postgres (TEST_DATABASE_URL). */
describeEventBroker('postgres', () => ({
  broker: service.app.get(EventBroker),
  maxAttempts: 3,
  elapse: async () => {
    await db.pool.query(`update deliveries set available_at = now() - interval '1 second'`);
  },
  reset,
}));

describeEventBrokerAdmin('postgres', () => ({
  broker: service.app.get(EventBroker),
  admin: service.app.get(EventBrokerAdmin),
  backdate: async (eventIds, days) => {
    await db.pool.query(
      `update events set published_at = published_at - make_interval(days => $2)
       where id = any($1::uuid[])`,
      [eventIds, days],
    );
  },
  reset,
}));
