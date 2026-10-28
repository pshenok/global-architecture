import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Event,
  type EventBusServiceClient,
  PublishOutcome,
} from '@ga/contracts/ga/event_bus/v1/event_bus';
import {
  createTestDatabase,
  type GrpcTestClient,
  grpcError,
  startTestService,
  type TestDatabase,
  type TestService,
} from '@ga/service-kit/testing';
import type { Metadata } from '@grpc/grpc-js';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { TOPICS } from '../src/domain/topics.ts';
import { SERVICE } from '../src/service.ts';

const HOUSE_DELETED = 'ga.house.v1.HouseDeletedEvent';
const USER_DELETED = 'ga.user.v1.UserDeletedEvent';
const STRANGER = '01900000-0000-7000-8000-0000000000ff';

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: randomUUID(),
    type: HOUSE_DELETED,
    aggregateId: randomUUID(),
    occurTime: new Date('2026-10-23T10:11:12.345Z'),
    payload: Buffer.from([10, 2, 104, 49]),
    requestId: 'req-1',
    traceparent: '',
    ...overrides,
  };
}

/** Real gRPC + Postgres: who may publish and pull what, and the API's limits. */
describe('EventBusService over gRPC', () => {
  let db: TestDatabase;
  let service: TestService;
  let client: GrpcTestClient<EventBusServiceClient>;
  const as = (workload: string) => service.asService(workload);

  beforeAll(async () => {
    db = await createTestDatabase({
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    service = await startTestService({
      module: AppModule,
      service: SERVICE,
      env: { DATABASE_URL: db.url },
      callers: ['house-service', 'user-service', 'booking-service', 'other-service'],
    });
    client = service.client<EventBusServiceClient>('ga.event_bus.v1.EventBusService');
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('deliveries', 'events'));

  const code = async (call: Promise<unknown>) => {
    const error = await grpcError(call);
    return { code: error.code, reason: error.details?.errorInfo?.reason };
  };
  /** One call per method, started only when invoked (a rejection never goes unhandled). */
  const everyMethod = (metadata: Metadata) => [
    () => client.publish({ events: [event()] }, metadata),
    () => client.pull({ types: [HOUSE_DELETED], maxDeliveries: 10 }, metadata),
    () => client.ack({ receipts: ['x'] }, metadata),
    () => client.nack({ receipt: 'x', reason: 'X', message: '', deadLetter: false }, metadata),
  ];
  const stored = async () => (await db.pool.query('select id from events')).rowCount;

  it('opens publish to the catalog producers and pull/ack/nack to its subscribers', () => {
    const listed = JSON.parse(
      readFileSync(new URL('../../../security/public-endpoints.json', import.meta.url), 'utf8'),
    ) as { endpoints: { where: string; reason: string }[] };
    const reasonOf = (method: string) =>
      listed.endpoints.find((e) => e.where.endsWith(`#EventBusGrpcController.${method}`))?.reason;
    const topics = Object.values(TOPICS);
    const producers = [...new Set(topics.map((t) => t.producer))].sort();
    const subscribers = [...new Set(topics.flatMap((t) => t.subscribers))].sort();
    expect(reasonOf('publish')).toBe(`workloads: ${producers.join(', ')}`);
    for (const method of ['pull', 'ack', 'nack']) {
      expect(reasonOf(method)).toBe(`workloads: ${subscribers.join(', ')}`);
    }
  });

  it('refuses callers that are not platform workloads (the gateway)', async () => {
    for (const call of everyMethod(await service.anonymous())) {
      expect(await code(call())).toEqual({
        code: status.PERMISSION_DENIED,
        reason: 'CALLER_NOT_ALLOWED',
      });
    }
  });

  it('refuses users, even admins', async () => {
    for (const call of everyMethod(await service.as(STRANGER, { roles: ['admin'] }))) {
      expect((await code(call())).code).toBe(status.PERMISSION_DENIED);
    }
  });

  it('refuses workloads it does not list', async () => {
    for (const call of everyMethod(await as('other-service'))) {
      expect(await code(call())).toEqual({
        code: status.PERMISSION_DENIED,
        reason: 'CALLER_NOT_ALLOWED',
      });
    }
    expect(await code(client.publish({ events: [event()] }, await as('booking-service')))).toEqual({
      code: status.PERMISSION_DENIED,
      reason: 'CALLER_NOT_ALLOWED',
    });
  });

  it('lets a producer publish only its own types, and refuses invalid events one by one', async () => {
    const own = event();
    const foreign = event({ type: USER_DELETED });
    const unknown = event({ type: 'ga.house.v1.HouseRenamedEvent' });
    const invalid = event({ aggregateId: '' });
    const tooBig = event({ payload: Buffer.alloc(64 * 1024 + 1) });
    const { results } = await client.publish(
      { events: [own, foreign, unknown, invalid, tooBig] },
      await as('house-service'),
    );
    expect(results.map((r) => [r.eventId, r.outcome, r.reason])).toEqual([
      [own.id, PublishOutcome.PUBLISH_OUTCOME_ACCEPTED, ''],
      [foreign.id, PublishOutcome.PUBLISH_OUTCOME_REJECTED, 'EVENT_TYPE_NOT_OWNED'],
      [unknown.id, PublishOutcome.PUBLISH_OUTCOME_REJECTED, 'EVENT_TYPE_UNKNOWN'],
      [invalid.id, PublishOutcome.PUBLISH_OUTCOME_REJECTED, 'INVALID_EVENT'],
      [tooBig.id, PublishOutcome.PUBLISH_OUTCOME_REJECTED, 'INVALID_EVENT'],
    ]);
    expect(await stored()).toBe(1);
  });

  it('is idempotent by event id and refuses a reused id', async () => {
    const published = event();
    const house = await as('house-service');
    const outcomes = async (e: Event) =>
      (await client.publish({ events: [e] }, house)).results.map((r) => [r.outcome, r.reason]);
    expect(await outcomes(published)).toEqual([[PublishOutcome.PUBLISH_OUTCOME_ACCEPTED, '']]);
    expect(await outcomes(published)).toEqual([[PublishOutcome.PUBLISH_OUTCOME_DUPLICATE, '']]);
    expect(await outcomes({ ...published, payload: Buffer.from([1]) })).toEqual([
      [PublishOutcome.PUBLISH_OUTCOME_REJECTED, 'EVENT_ID_REUSED'],
    ]);
  });

  it('fans an event out to every subscriber, stamped with the verified producer', async () => {
    const published = event({ type: USER_DELETED, requestId: 'req-42' });
    await client.publish({ events: [published] }, await as('user-service'));
    for (const subscriber of ['house-service', 'booking-service']) {
      const { deliveries } = await client.pull(
        { types: [USER_DELETED], maxDeliveries: 10 },
        await as(subscriber),
      );
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        event: { ...published, payload: published.payload },
        producer: 'user-service',
        attempt: 1,
      });
      expect(deliveries[0]?.publishTime).toBeInstanceOf(Date);
    }
  });

  it('keeps each subscriber to its own types and its own deliveries', async () => {
    expect(
      await code(
        client.pull({ types: [HOUSE_DELETED], maxDeliveries: 10 }, await as('house-service')),
      ),
    ).toEqual({ code: status.PERMISSION_DENIED, reason: 'EVENT_TYPE_NOT_SUBSCRIBED' });
    await client.publish({ events: [event({ type: USER_DELETED })] }, await as('user-service'));
    const house = await as('house-service');
    const booking = await as('booking-service');
    const [leased] = (await client.pull({ types: [USER_DELETED], maxDeliveries: 10 }, house))
      .deliveries;
    const receipt = leased?.receipt ?? '';
    await client.ack({ receipts: [receipt] }, booking);
    await client.nack({ receipt, reason: 'X', message: '', deadLetter: true }, booking);
    const rows = await db.pool.query(
      `select subscriber, status, lease_token from deliveries order by subscriber`,
    );
    expect(rows.rows.map((r) => [r.subscriber, r.status, r.lease_token !== null])).toEqual([
      ['booking-service', 'PENDING', false],
      ['house-service', 'PENDING', true],
    ]);
    await client.ack({ receipts: [receipt] }, house);
    expect((await db.pool.query(`select 1 from deliveries`)).rowCount).toBe(1);
  });

  it('refuses requests outside the limits', async () => {
    const house = await as('house-service');
    const booking = await as('booking-service');
    const invalid = { code: status.INVALID_ARGUMENT, reason: 'VALIDATION_FAILED' };
    const many = Array.from({ length: 51 }, () => event());
    expect(await code(client.publish({ events: [] }, house))).toEqual(invalid);
    expect(await code(client.publish({ events: many }, house))).toEqual(invalid);
    for (const maxDeliveries of [0, 101]) {
      expect(await code(client.pull({ types: [HOUSE_DELETED], maxDeliveries }, booking))).toEqual(
        invalid,
      );
    }
    expect(
      await code(client.ack({ receipts: Array.from({ length: 101 }, () => 'r') }, booking)),
    ).toEqual(invalid);
    expect(
      await code(
        client.nack({ receipt: 'r', reason: 'lower', message: '', deadLetter: false }, booking),
      ),
    ).toEqual(invalid);
  });
});
