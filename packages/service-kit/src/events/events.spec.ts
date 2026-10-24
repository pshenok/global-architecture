import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HouseDeletedEvent } from '@ga/contracts/ga/house/v1/house_events';
import type { UserServiceClient } from '@ga/contracts/ga/user/v1/user';
import type { UserDeletedEvent } from '@ga/contracts/ga/user/v1/user_events';
import {
  ConcurrencyError,
  DependencyUnavailableError,
  NotFoundError,
  PreconditionFailedError,
  UnitOfWork,
} from '@ga/kernel';
import { Inject, Injectable, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLS_ID, ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  actorFromClaims,
  currentCaller,
  currentEvent,
  currentPrincipalToken,
  currentService,
  enterVerifiedCall,
} from '../auth/principal-context.ts';
import { databaseConfigSchema, grpcServiceConfigSchema, grpcTarget } from '../config/config.ts';
import { currentRequestId } from '../context/request-context.ts';
import { DbContext } from '../database/db-context.ts';
import { GrpcClientsModule } from '../grpc/grpc-clients.module.ts';
import { GrpcPlatformModule } from '../platform/grpc-platform.module.ts';
import { defineService } from '../platform/service-definition.ts';
import {
  deliverEvent,
  FakeEventBus,
  flushOutbox,
  recordedEvents,
  testDelivery,
} from '../testing/events.ts';
import { startTestService, type TestService } from '../testing/start-test-service.ts';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.ts';
import { eventsConfigSchema } from './config.ts';
import { EventBusClient, type WireEvent } from './event-bus.client.ts';
import { EventConsumer } from './event-consumer.ts';
import { defineEvent } from './event-type.ts';
import { EventsModule } from './events.module.ts';
import { OnEvent } from './on-event.ts';
import { Outbox } from './outbox.ts';

const HOUSE_DELETED = defineEvent<HouseDeletedEvent>('ga.house.v1.HouseDeletedEvent', {
  producer: 'house-service',
});
const USER_DELETED = defineEvent<UserDeletedEvent>('ga.user.v1.UserDeletedEvent', {
  producer: 'user-service',
});

const TABLES = `
create table outbox (
  id uuid primary key, type text not null, aggregate_id text not null,
  occurred_at timestamp(3) with time zone not null, payload bytea not null,
  request_id text, traceparent text, attempts integer default 0 not null,
  available_at timestamp(3) with time zone default now() not null,
  lease_token uuid, last_error text);
create table processed_events (
  subscription text not null, event_id uuid not null, type text not null,
  processed_at timestamp(3) with time zone default now() not null,
  constraint processed_events_pkey primary key (subscription, event_id));
create table effects (id text primary key);`;

const SERVICE = defineService({
  name: 'house-service',
  protoFiles: ['ga/house/v1/house.proto'],
  packages: ['ga.house.v1'],
  services: ['ga.house.v1.HouseService'],
});
const USERS = Symbol('USERS');
const ConfigSchema = grpcServiceConfigSchema
  .extend(databaseConfigSchema.shape)
  .extend(eventsConfigSchema.shape)
  .extend({ USER_SERVICE_URL: grpcTarget() });

/** Lets a test hold a handler inside its transaction. */
const gate: { wait?: Promise<void>; entered?: () => void } = {};
let seen: Record<string, unknown> = {};

/** Behaves as the payload's userId says: the kit's view of a real consumer. */
@Injectable()
class UserEventsConsumer {
  constructor(
    private readonly db: DbContext,
    @Inject(USERS) private readonly users: UserServiceClient,
  ) {}

  @OnEvent(USER_DELETED)
  async userDeleted(event: UserDeletedEvent): Promise<void> {
    seen = {
      service: currentService(),
      event: currentEvent(),
      principal: currentPrincipalToken(),
      caller: currentCaller(),
      requestId: currentRequestId(),
      inTransaction: this.db.inTransaction(),
    };
    const [behaviour = '', id] = event.userId.split(':');
    await this.db.tx.execute(sql`insert into effects (id) values (${id ?? behaviour})`);
    gate.entered?.();
    if (gate.wait) await gate.wait;
    switch (behaviour) {
      case 'conflict':
        throw new ConcurrencyError('ROW_CHANGED', 'changed meanwhile');
      case 'unavailable':
        throw new DependencyUnavailableError('USER_SERVICE_UNAVAILABLE', 'down');
      case 'serialization':
        throw Object.assign(new Error('could not serialize'), { code: '40001', severity: 'ERROR' });
      case 'bug':
        throw new TypeError('undefined is not a function');
      case 'precondition':
        throw new PreconditionFailedError('HOUSE_GONE', 'gone');
      case 'missing':
        throw new NotFoundError('USER_NOT_FOUND', 'no such user');
      case 'remote':
        await firstValueFrom(this.users.getUser({ id: 'x' }));
        break;
      default:
        break;
    }
  }
}

@Module({
  imports: [
    GrpcPlatformModule.forRoot({ service: SERVICE, config: ConfigSchema }),
    EventsModule.forRoot({ publish: true, consume: true }),
    GrpcClientsModule.register([
      {
        token: USERS,
        service: 'ga.user.v1.UserService',
        target: 'user-service',
        protoFiles: ['ga/user/v1/user.proto'],
        url: (config) => String(config.USER_SERVICE_URL),
      },
    ]),
  ],
  providers: [UserEventsConsumer],
})
class AppModule {}

const folders: string[] = [];
function migrations(sql: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'ga-events-'));
  folders.push(folder);
  mkdirSync(join(folder, '20260101000000_init'));
  writeFileSync(join(folder, '20260101000000_init', 'migration.sql'), sql);
  writeFileSync(join(folder, '20260101000000_init', 'snapshot.json'), '{}');
  return folder;
}

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const start = (db: TestDatabase, bus: EventBusClient, env: Record<string, string> = {}) =>
  startTestService({
    module: AppModule,
    service: SERVICE,
    env: { DATABASE_URL: db.url, USER_SERVICE_URL: '127.0.0.1:1', ...env },
    override: (builder) => builder.overrideProvider(EventBusClient).useValue(bus),
  });

const inContext = <T>(work: () => Promise<T>, requestId = 'req-test'): Promise<T> => {
  const cls = ClsServiceManager.getClsService();
  return cls.run(() => {
    cls.set(CLS_ID, requestId);
    return work();
  });
};

describe('events (real Postgres)', () => {
  let db: TestDatabase;
  let bus: FakeEventBus;
  let service: TestService;
  let outbox: Outbox;
  let unitOfWork: UnitOfWork;

  beforeAll(async () => {
    db = await createTestDatabase({ migrationsFolder: migrations(TABLES) });
    bus = new FakeEventBus();
    service = await start(db, bus);
    outbox = service.app.get(Outbox);
    unitOfWork = service.app.get(UnitOfWork);
  });

  afterAll(async () => {
    await service?.close();
    await db?.dispose();
  });

  beforeEach(async () => {
    await db.truncate('outbox', 'processed_events', 'effects');
    bus.published.length = 0;
    bus.acked.length = 0;
    bus.nacked.length = 0;
    bus.pulls.length = 0;
    bus.respond(() => ({ outcome: 'ACCEPTED', reason: '' }));
    seen = {};
  });

  afterEach(() => {
    delete gate.wait;
    delete gate.entered;
  });

  const record = (houseId: string) =>
    inContext(() =>
      unitOfWork.run(() => outbox.add(HOUSE_DELETED, houseId, { houseId, ownerId: 'owner' })),
    );
  const rows = async () =>
    (await db.pool.query('select * from outbox order by id')).rows as {
      id: string;
      attempts: number;
      last_error: string | null;
      available_at: Date;
      lease_token: string | null;
    }[];
  const effects = async () =>
    (await db.pool.query('select id from effects order by id')).rows.map((r) => r.id as string);

  describe('Outbox.add', () => {
    it('records the event with the change, stamped with the request', async () => {
      await record('h1');
      const [event] = await recordedEvents(db.pool, HOUSE_DELETED);
      expect(event).toMatchObject({
        aggregateId: 'h1',
        payload: { houseId: 'h1', ownerId: 'owner' },
        requestId: 'req-test',
      });
      expect(event?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
      const [row] = await rows();
      expect(row?.attempts).toBe(0);
      expect(row?.available_at.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('refuses to record outside a transaction, or an event another workload owns', async () => {
      await expect(
        inContext(() => outbox.add(HOUSE_DELETED, 'h1', { houseId: 'h1', ownerId: 'o' })),
      ).rejects.toThrow(/outside UnitOfWork.run/);
      await expect(
        inContext(() => unitOfWork.run(() => outbox.add(USER_DELETED, 'u1', { userId: 'u1' }))),
      ).rejects.toThrow(/user-service owns it/);
      await expect(record('x'.repeat(129))).rejects.toThrow(/1..128/);
      expect(await rows()).toEqual([]);
    });

    it('rolls the event back with its change, and the change back with a refused event', async () => {
      const failingChange = inContext(() =>
        unitOfWork.run(async () => {
          await outbox.add(HOUSE_DELETED, 'h1', { houseId: 'h1', ownerId: 'o' });
          throw new Error('the change failed');
        }),
      );
      await expect(failingChange).rejects.toThrow('the change failed');
      const tooBig = inContext(() =>
        unitOfWork.run(async () => {
          await service.app
            .get(DbContext)
            .tx.execute(sql`insert into effects (id) values ('kept?')`);
          await outbox.add(HOUSE_DELETED, 'h2', { houseId: 'x'.repeat(70_000), ownerId: 'o' });
        }),
      );
      await expect(tooBig).rejects.toThrow(/over 64 KiB/);
      expect(await rows()).toEqual([]);
      expect(await effects()).toEqual([]);
    });
  });

  describe('OutboxRelay', () => {
    it('publishes every due row in one call and deletes what the bus holds', async () => {
      await record('h1');
      await record('h2');
      bus.respond((event) =>
        event.aggregateId === 'h1'
          ? { outcome: 'ACCEPTED', reason: '' }
          : { outcome: 'DUPLICATE', reason: '' },
      );
      expect(await flushOutbox(service.app)).toBe(2);
      expect(bus.published.map((e) => e.aggregateId).sort()).toEqual(['h1', 'h2']);
      expect(bus.published[0]).toMatchObject({ type: HOUSE_DELETED.type, requestId: 'req-test' });
      expect(await rows()).toEqual([]);
      expect(await flushOutbox(service.app)).toBe(0);
    });

    it('backs off refused and unavailable rows, alone', async () => {
      for (const id of ['ok', 'refused', 'unavailable']) await record(id);
      bus.respond((event) =>
        event.aggregateId === 'refused'
          ? { outcome: 'REJECTED', reason: 'EVENT_TYPE_UNKNOWN' }
          : event.aggregateId === 'unavailable'
            ? { outcome: 'UNAVAILABLE', reason: 'STORE_UNAVAILABLE' }
            : { outcome: 'ACCEPTED', reason: '' },
      );
      await flushOutbox(service.app);
      const left = await rows();
      expect(left.map((r) => [r.attempts, r.last_error, r.lease_token]).sort()).toEqual([
        [1, 'REJECTED EVENT_TYPE_UNKNOWN', null],
        [1, 'UNAVAILABLE STORE_UNAVAILABLE', null],
      ]);
      for (const row of left) expect(row.available_at.getTime()).toBeGreaterThan(Date.now());
      expect(await flushOutbox(service.app)).toBe(0);
    });

    it('backs off every claimed row when the bus cannot be reached', async () => {
      await record('h1');
      await record('h2');
      bus.failNext(new DependencyUnavailableError('EVENT_BUS_SERVICE_UNAVAILABLE', 'down'));
      expect(await flushOutbox(service.app)).toBe(2);
      const left = await rows();
      expect(left).toHaveLength(2);
      for (const row of left) {
        expect(row.last_error).toMatch(/^PUBLISH_FAILED/);
        expect(row.available_at.getTime()).toBeGreaterThan(Date.now());
      }
    });

    it('settles only its own lease', async () => {
      await record('h1');
      const release = bus.hold();
      const flushing = flushOutbox(service.app);
      await expect.poll(async () => (await rows())[0]?.lease_token).not.toBeNull();
      // Another relay claimed the row meanwhile (its lease had ended).
      await db.pool.query('update outbox set lease_token = gen_random_uuid()');
      release();
      await flushing;
      expect(await rows()).toHaveLength(1);
    });

    it('never publishes a row twice from concurrent rounds', async () => {
      for (let i = 0; i < 30; i += 1) await record(`h${i}`);
      await Promise.all([flushOutbox(service.app), flushOutbox(service.app)]);
      const ids = bus.published.map((e) => e.id);
      expect(ids).toHaveLength(30);
      expect(new Set(ids).size).toBe(30);
    });

    it("publishes as the service itself, never with a user's principal", async () => {
      await record('h1');
      let principal: unknown = 'unset';
      const spy = new FakeEventBus();
      spy.publish = async (events: readonly WireEvent[]) => {
        principal = currentPrincipalToken();
        return events.map((event) => ({ eventId: event.id, outcome: 'ACCEPTED', reason: '' }));
      };
      const other = await start(db, spy);
      try {
        await inContext(() => {
          enterVerifiedCall(ClsServiceManager.getClsService(), {
            caller: 'gateway',
            actor: actorFromClaims({ kind: 'user', userId: 'u1', roles: [] }),
            principalToken: 'a-user-principal',
          });
          return flushOutbox(other.app);
        });
      } finally {
        await other.close();
      }
      expect(principal).toBeUndefined();
    });
  });

  describe('EventConsumer', () => {
    it('runs the handler as the service itself, in a transaction, once per event', async () => {
      const id = '01900000-0000-7000-8000-00000000e001';
      const options = { id, requestId: 'req-origin', attempt: 2, aggregateId: 'u1' };
      expect(await deliverEvent(service.app, USER_DELETED, { userId: 'ok:u1' }, options)).toBe(
        'applied',
      );
      expect(seen).toEqual({
        service: { kind: 'service', name: 'house-service' },
        event: expect.objectContaining({
          id,
          type: USER_DELETED.type,
          producer: 'user-service',
          attempt: 2,
          aggregateId: 'u1',
        }),
        principal: undefined,
        caller: undefined,
        requestId: 'req-origin',
        inTransaction: true,
      });
      expect(await deliverEvent(service.app, USER_DELETED, { userId: 'ok:u1' }, options)).toBe(
        'duplicate',
      );
      expect(await effects()).toEqual(['u1']);
    });

    it('applies one of two concurrent deliveries of the same event', async () => {
      const id = '01900000-0000-7000-8000-00000000e002';
      let open!: () => void;
      gate.wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        gate.entered = resolve;
      });
      const first = deliverEvent(service.app, USER_DELETED, { userId: 'ok:u2' }, { id });
      await entered;
      const second = deliverEvent(service.app, USER_DELETED, { userId: 'ok:u2' }, { id });
      open();
      expect([await first, await second]).toEqual(['applied', 'duplicate']);
      expect(await effects()).toEqual(['u2']);
    });

    it('rolls back a failed handler and says whether to retry or dead-letter', async () => {
      const outcome = (userId: string) => deliverEvent(service.app, USER_DELETED, { userId });
      expect(await outcome('conflict:a')).toMatchObject({ retry: 'ROW_CHANGED' });
      expect(await outcome('unavailable:b')).toMatchObject({ retry: 'USER_SERVICE_UNAVAILABLE' });
      expect(await outcome('serialization:c')).toMatchObject({ retry: 'TRANSACTION_CONFLICT' });
      expect(await outcome('bug:d')).toMatchObject({ retry: 'HANDLER_FAILED' });
      expect(await outcome('precondition:e')).toMatchObject({ dead: 'HOUSE_GONE' });
      expect(await outcome('missing:f')).toMatchObject({ dead: 'USER_NOT_FOUND' });
      expect(await outcome('remote:g')).toMatchObject({ dead: 'REMOTE_CALL_IN_TRANSACTION' });
      expect(await effects()).toEqual([]);
      expect((await db.pool.query('select 1 from processed_events')).rowCount).toBe(0);
    });

    it('dead-letters what it cannot trust or read', async () => {
      expect(
        await deliverEvent(
          service.app,
          USER_DELETED,
          { userId: 'ok:x' },
          { producer: 'booking-service' },
        ),
      ).toMatchObject({ dead: 'UNEXPECTED_PRODUCER' });
      expect(
        await deliverEvent(
          service.app,
          USER_DELETED,
          { userId: '' },
          { rawPayload: Uint8Array.of(0x0a, 0x10, 0x61) },
        ),
      ).toMatchObject({ dead: 'EVENT_UNDECODABLE' });
      expect(await effects()).toEqual([]);
    });

    it('pulls the handled types, acks successes together and nacks each failure', async () => {
      const ok1 = testDelivery(USER_DELETED, { userId: 'ok:p1' });
      const ok2 = testDelivery(USER_DELETED, { userId: 'ok:p2' });
      const retry = testDelivery(USER_DELETED, { userId: 'conflict:p3' });
      const dead = testDelivery(USER_DELETED, { userId: 'precondition:p4' });
      bus.queue.push(ok1, retry, ok2, dead);
      expect(await service.app.get(EventConsumer).pollOnce()).toBe(4);
      expect(bus.pulls).toEqual([{ types: [USER_DELETED.type], max: 10 }]);
      expect(bus.acked).toEqual([ok1.receipt, ok2.receipt]);
      expect(bus.nacked).toEqual([
        {
          receipt: retry.receipt,
          failure: { reason: 'ROW_CHANGED', message: 'changed meanwhile', deadLetter: false },
        },
        {
          receipt: dead.receipt,
          failure: { reason: 'HOUSE_GONE', message: 'gone', deadLetter: true },
        },
      ]);
    });
  });
});

describe('events at boot and shutdown', () => {
  it('fails boot without the event tables the enabled side needs', async () => {
    const bare = await createTestDatabase({
      migrationsFolder: migrations('create table x (id int);'),
    });
    try {
      await expect(start(bare, new FakeEventBus())).rejects.toThrow(/table outbox is missing/);
    } finally {
      await bare.dispose();
    }
    const noUnique = await createTestDatabase({
      migrationsFolder: migrations(
        TABLES.replace(
          'constraint processed_events_pkey primary key (subscription, event_id)',
          'x int',
        ),
      ),
    });
    try {
      await expect(start(noUnique, new FakeEventBus())).rejects.toThrow(
        /unique key on \(subscription, event_id\)/,
      );
    } finally {
      await noUnique.dispose();
    }
  });

  it('fails boot on two handlers of one type', async () => {
    @Injectable()
    class Twin {
      @OnEvent(USER_DELETED)
      async again(_event: UserDeletedEvent): Promise<void> {}
    }
    @Module({ imports: [AppModule], providers: [Twin] })
    class TwinModule {}
    const db = await createTestDatabase({ migrationsFolder: migrations(TABLES) });
    try {
      await expect(
        startTestService({
          module: TwinModule,
          service: SERVICE,
          env: { DATABASE_URL: db.url, USER_SERVICE_URL: '127.0.0.1:1' },
        }),
      ).rejects.toThrow(/two handlers of ga.user.v1.UserDeletedEvent/);
    } finally {
      await db.dispose();
    }
  });

  it('waits for an in-flight publish on shutdown, at most EVENTS_DRAIN_MS', async () => {
    const db = await createTestDatabase({ migrationsFolder: migrations(TABLES) });
    try {
      const record = async (app: TestService) =>
        inContext(() =>
          app.app
            .get(UnitOfWork)
            .run(() => app.app.get(Outbox).add(HOUSE_DELETED, 'h', { houseId: 'h', ownerId: 'o' })),
        );
      const autostart = { EVENTS_AUTOSTART: 'true', EVENTS_POLL_MS: '50', EVENTS_DRAIN_MS: '300' };

      // Released while shutting down: close waits for it, and the row is settled.
      const patient = new FakeEventBus();
      const release = patient.hold();
      const first = await start(db, patient, autostart);
      await record(first);
      await expect
        .poll(
          async () => (await db.pool.query('select lease_token from outbox')).rows[0]?.lease_token,
        )
        .not.toBeNull();
      const closing = first.close();
      release();
      await closing;
      expect(patient.published).toHaveLength(1);
      expect((await db.pool.query('select 1 from outbox')).rowCount).toBe(0);

      // Never released: close gives up after the drain budget; the row waits for the next start.
      const stuck = new FakeEventBus();
      stuck.hold();
      const second = await start(db, stuck, autostart);
      await record(second);
      await expect
        .poll(
          async () => (await db.pool.query('select lease_token from outbox')).rows[0]?.lease_token,
        )
        .not.toBeNull();
      const before = performance.now();
      await second.close();
      expect(performance.now() - before).toBeLessThan(2_000);
      expect((await db.pool.query('select 1 from outbox')).rowCount).toBe(1);
    } finally {
      await db.dispose();
    }
  });
});
