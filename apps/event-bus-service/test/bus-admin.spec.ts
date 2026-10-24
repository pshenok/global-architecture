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
import { drop, redrive, replay, status } from '../src/cli/bus-admin.ts';
import { MAX_RETENTION_DAYS } from '../src/domain/retention.ts';
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

  /** A delivery the catalog no longer lists (house-service is not a HouseDeleted subscriber). */
  const orphan = (eventId: string, state: 'PENDING' | 'DEAD') =>
    db.pool.query(
      `insert into deliveries (subscriber, event_id, type, status) values ('house-service', $1, $2, $3)`,
      [eventId, HOUSE_DELETED, state],
    );

  it('counts pending and dead deliveries per subscriber and type', async () => {
    await broker.publish(busEvent(), ['booking-service']);
    await broker.publish(busEvent(), ['booking-service']);
    await broker.publish(busEvent({ type: USER_DELETED, producer: 'user-service' }), [
      'house-service',
      'booking-service',
    ]);
    await deadLetter('booking-service', HOUSE_DELETED);
    const listed = { orphaned: false };
    expect((await status(orm())).map(({ oldestPendingS: _, ...row }) => row)).toEqual([
      { ...listed, subscriber: 'booking-service', type: HOUSE_DELETED, pending: 1, dead: 1 },
      { ...listed, subscriber: 'booking-service', type: USER_DELETED, pending: 1, dead: 0 },
      { ...listed, subscriber: 'house-service', type: USER_DELETED, pending: 1, dead: 0 },
    ]);
  });

  it('flags deliveries of a pair the catalog no longer lists', async () => {
    const event = busEvent();
    await broker.publish(event, ['booking-service']);
    await orphan(event.id, 'DEAD');
    expect(
      (await status(orm())).map(({ subscriber, type, orphaned }) => ({
        subscriber,
        type,
        orphaned,
      })),
    ).toEqual([
      { subscriber: 'booking-service', type: HOUSE_DELETED, orphaned: false },
      { subscriber: 'house-service', type: HOUSE_DELETED, orphaned: true },
    ]);
  });

  it('redrives dead letters with fresh attempts, filtered by type', async () => {
    await broker.publish(busEvent(), ['booking-service']);
    await broker.publish(busEvent({ type: USER_DELETED, producer: 'user-service' }), [
      'booking-service',
    ]);
    await deadLetter('booking-service', HOUSE_DELETED);
    await deadLetter('booking-service', USER_DELETED);
    expect(await redrive(orm(), { subscriber: 'booking-service', type: HOUSE_DELETED })).toEqual({
      redriven: 1,
      skipped: 0,
    });
    const [again] = await broker.pull('booking-service', [HOUSE_DELETED, USER_DELETED], 10);
    expect(again).toMatchObject({ attempt: 1, event: { type: HOUSE_DELETED } });
    expect(await redrive(orm(), { subscriber: 'booking-service' })).toEqual({
      redriven: 1,
      skipped: 0,
    });
  });

  it('redrives only types the catalog lists for the subscriber', async () => {
    const houseDeleted = busEvent();
    await broker.publish(houseDeleted, ['booking-service']);
    await broker.publish(busEvent({ type: USER_DELETED, producer: 'user-service' }), [
      'house-service',
    ]);
    await deadLetter('house-service', USER_DELETED);
    await orphan(houseDeleted.id, 'DEAD');
    await expect(
      redrive(orm(), { subscriber: 'house-service', type: HOUSE_DELETED }),
    ).rejects.toThrow(/does not list house-service/);
    await expect(redrive(orm(), { subscriber: 'house-service', type: '' })).rejects.toThrow(
      /does not list house-service/,
    );
    expect(await redrive(orm(), { subscriber: 'house-service' })).toEqual({
      redriven: 1,
      skipped: 1,
    });
    const left = await db.pool.query(
      `select type, status from deliveries where subscriber = 'house-service' order by type`,
    );
    expect(left.rows).toEqual([
      { type: HOUSE_DELETED, status: 'DEAD' },
      { type: USER_DELETED, status: 'PENDING' },
    ]);
  });

  it('drops the deliveries of an unlisted pair so retention can purge their events', async () => {
    const pending = busEvent();
    const dead = busEvent();
    for (const event of [pending, dead]) await broker.publish(event, []);
    await orphan(pending.id, 'PENDING');
    await orphan(dead.id, 'DEAD');
    await broker.publish(busEvent({ type: USER_DELETED, producer: 'user-service' }), [
      'house-service',
    ]);
    await db.pool.query(`update events set published_at = now() - interval '8 days'`);
    const retention = service.app.get(EventRetention);
    expect(await retention.purge()).toBe(0);
    await expect(
      drop(orm(), { subscriber: 'booking-service', type: HOUSE_DELETED }),
    ).rejects.toThrow(/still lists booking-service/);
    await expect(drop(orm(), { subscriber: 'house-service', type: USER_DELETED })).rejects.toThrow(
      /still lists house-service/,
    );
    expect(await drop(orm(), { subscriber: 'house-service', type: HOUSE_DELETED })).toBe(2);
    expect(await retention.purge()).toBe(2);
    const left = await db.pool.query('select subscriber, type from deliveries');
    expect(left.rows).toEqual([{ subscriber: 'house-service', type: USER_DELETED }]);
  });

  it('replays retained events only to subscribers the catalog lists', async () => {
    const old = busEvent({ type: USER_DELETED, producer: 'user-service' });
    await broker.publish(old, ['booking-service']);
    const since = new Date(Date.now() - 60_000);
    const replayTo = (subscriber: string) =>
      replay(orm(), { subscriber, type: USER_DELETED, since });
    expect(await replayTo('house-service')).toEqual({ queued: 1, skipped: 0 });
    expect(await replayTo('house-service')).toEqual({ queued: 0, skipped: 0 });
    expect(await replayTo('booking-service')).toEqual({ queued: 0, skipped: 0 });
    await expect(
      replay(orm(), { subscriber: 'house-service', type: HOUSE_DELETED, since }),
    ).rejects.toThrow(/does not list house-service/);
    const [replayed] = await broker.pull('house-service', [USER_DELETED], 10);
    expect(replayed?.event.id).toBe(old.id);
  });

  it('replays no event older than consumers remember, even one a dead letter kept', async () => {
    const forgotten = busEvent({ type: USER_DELETED, producer: 'user-service' });
    const recent = busEvent({ type: USER_DELETED, producer: 'user-service' });
    for (const event of [forgotten, recent]) {
      await broker.publish(event, ['house-service', 'booking-service']);
    }
    const applied = await broker.pull('house-service', [USER_DELETED], 10);
    await broker.ack(
      'house-service',
      applied.map((d) => d.receipt),
    );
    await deadLetter('booking-service', USER_DELETED);
    await deadLetter('booking-service', USER_DELETED);
    const age = (id: string, days: number) =>
      db.pool.query(
        'update events set published_at = now() - make_interval(days => $2) where id = $1',
        [id, days],
      );
    await age(forgotten.id, MAX_RETENTION_DAYS + 19);
    await age(recent.id, MAX_RETENTION_DAYS - 1);
    const since = new Date(Date.now() - 60 * 86_400_000);
    const target = { subscriber: 'house-service', type: USER_DELETED, since };
    expect(await replay(orm(), target)).toEqual({ queued: 1, skipped: 1 });
    expect(await replay(orm(), target)).toEqual({ queued: 0, skipped: 1 });
    const replayed = await broker.pull('house-service', [USER_DELETED], 10);
    expect(replayed.map((d) => d.event.id)).toEqual([recent.id]);
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
