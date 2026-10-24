import { fileURLToPath } from 'node:url';
import {
  createTestDatabase,
  startTestService,
  type TestDatabase,
  type TestService,
} from '@ga/service-kit/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { EventBroker } from '../src/application/ports/event-broker.ts';
import { redrive, replay, status } from '../src/cli/bus-admin.ts';
import { EventRetention } from '../src/infrastructure/retention.ts';
import { SERVICE } from '../src/service.ts';
import { busEvent } from './event-broker.contract.ts';

const HOUSE_DELETED = 'ga.house.v1.HouseDeletedEvent';
const USER_DELETED = 'ga.user.v1.UserDeletedEvent';

/** The operator commands and retention, against real Postgres. */
describe('bus administration', () => {
  let db: TestDatabase;
  let service: TestService;
  let broker: EventBroker;
  const orm = () => drizzle({ client: db.pool });

  beforeAll(async () => {
    db = await createTestDatabase({
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    service = await startTestService({
      module: AppModule,
      service: SERVICE,
      env: { DATABASE_URL: db.url, EVENT_BUS_RETENTION_DAYS: '7' },
    });
    broker = service.app.get(EventBroker);
  });

  afterAll(async () => {
    await service?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('deliveries', 'events'));

  const deadLetter = async (subscriber: string, type: string) => {
    const [delivery] = await broker.pull(subscriber, [type], 1);
    await broker.nack(subscriber, delivery?.receipt ?? '', {
      reason: 'HANDLER_FAILED',
      message: 'boom',
      deadLetter: true,
    });
  };

  it('counts pending and dead deliveries per subscriber and type', async () => {
    await broker.publish(busEvent(), ['booking-service']);
    await broker.publish(busEvent(), ['booking-service']);
    await broker.publish(busEvent({ type: USER_DELETED, producer: 'user-service' }), [
      'house-service',
      'booking-service',
    ]);
    await deadLetter('booking-service', HOUSE_DELETED);
    expect((await status(orm())).map(({ oldestPendingS: _, ...row }) => row)).toEqual([
      { subscriber: 'booking-service', type: HOUSE_DELETED, pending: 1, dead: 1 },
      { subscriber: 'booking-service', type: USER_DELETED, pending: 1, dead: 0 },
      { subscriber: 'house-service', type: USER_DELETED, pending: 1, dead: 0 },
    ]);
  });

  it('redrives dead letters with fresh attempts, filtered by type', async () => {
    await broker.publish(busEvent(), ['booking-service']);
    await broker.publish(busEvent({ type: USER_DELETED, producer: 'user-service' }), [
      'booking-service',
    ]);
    await deadLetter('booking-service', HOUSE_DELETED);
    await deadLetter('booking-service', USER_DELETED);
    expect(await redrive(orm(), { subscriber: 'booking-service', type: HOUSE_DELETED })).toBe(1);
    const [again] = await broker.pull('booking-service', [HOUSE_DELETED, USER_DELETED], 10);
    expect(again).toMatchObject({ attempt: 1, event: { type: HOUSE_DELETED } });
    expect(await redrive(orm(), { subscriber: 'booking-service' })).toBe(1);
  });

  it('replays retained events only to subscribers the catalog lists', async () => {
    const old = busEvent({ type: USER_DELETED, producer: 'user-service' });
    await broker.publish(old, ['booking-service']);
    const since = new Date(Date.now() - 60_000);
    expect(await replay(orm(), { subscriber: 'house-service', type: USER_DELETED, since })).toBe(1);
    expect(await replay(orm(), { subscriber: 'house-service', type: USER_DELETED, since })).toBe(0);
    expect(await replay(orm(), { subscriber: 'booking-service', type: USER_DELETED, since })).toBe(
      0,
    );
    await expect(
      replay(orm(), { subscriber: 'house-service', type: HOUSE_DELETED, since }),
    ).rejects.toThrow(/does not list house-service/);
    const [replayed] = await broker.pull('house-service', [USER_DELETED], 10);
    expect(replayed?.event.id).toBe(old.id);
  });

  it('deletes delivered events past retention and keeps those with a delivery', async () => {
    const delivered = busEvent();
    const dead = busEvent();
    const recent = busEvent();
    for (const event of [delivered, dead, recent]) await broker.publish(event, ['booking-service']);
    const leased = await broker.pull('booking-service', [HOUSE_DELETED], 10);
    const receiptOf = (id: string) => leased.find((d) => d.event.id === id)?.receipt ?? '';
    await broker.ack('booking-service', [receiptOf(delivered.id), receiptOf(recent.id)]);
    await broker.nack('booking-service', receiptOf(dead.id), {
      reason: 'X',
      message: '',
      deadLetter: true,
    });
    await db.pool.query(
      `update events set published_at = now() - interval '8 days' where id = any($1::uuid[])`,
      [[delivered.id, dead.id]],
    );
    expect(await service.app.get(EventRetention).purge()).toBe(1);
    const left = await db.pool.query('select id from events order by id');
    expect(left.rows.map((r) => r.id).sort()).toEqual([dead.id, recent.id].sort());
  });
});
