import { fileURLToPath } from 'node:url';
import type { SampleItemServiceClient } from '@ga/contracts/ga/sample_item/v1/sample_item';
import {
  createTestDatabase,
  type GrpcTestClient,
  grpcError,
  startTestService,
  type TestDatabase,
  type TestService,
} from '@ga/service-kit/testing';
import { type Metadata, status } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { SERVICE } from '../src/service.ts';

const OWNER = '01900000-0000-7000-8000-0000000000a1';
const STRANGER = '01900000-0000-7000-8000-0000000000b1';

/**
 * End-to-end through the real stack: gRPC wire -> auth guard -> controller -> use
 * case -> Drizzle -> Postgres (an isolated schema with the real migrations).
 */
describe('SampleItemService over gRPC', () => {
  let db: TestDatabase;
  let service: TestService;
  let client: GrpcTestClient<SampleItemServiceClient>;
  let asOwner: Metadata;

  beforeAll(async () => {
    db = await createTestDatabase({
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    service = await startTestService({
      module: AppModule,
      service: SERVICE,
      env: { DATABASE_URL: db.url },
      callers: ['other-service'],
    });
    client = service.client<SampleItemServiceClient>(SERVICE.services[0] as string);
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(async () => {
    await db.truncate('sample_items');
    asOwner = await service.as(OWNER);
  });

  const create = async (name: string) =>
    (await client.createSampleItem({ name, description: '' }, asOwner)).sampleItem?.id as string;

  it('creates, reads, updates and deletes', async () => {
    const { sampleItem } = await client.createSampleItem(
      { name: ' Lamp ', description: 'warm' },
      asOwner,
    );
    expect(sampleItem).toMatchObject({ name: 'Lamp', description: 'warm', ownerId: OWNER });
    expect(sampleItem?.createTime).toBeInstanceOf(Date);
    const id = sampleItem?.id as string;

    await expect(client.getSampleItem({ id }, asOwner)).resolves.toMatchObject({
      sampleItem: { id, name: 'Lamp' },
    });

    const updated = await client.updateSampleItem({ id, description: 'cold' }, asOwner);
    expect(updated.sampleItem).toMatchObject({ name: 'Lamp', description: 'cold' });

    await client.deleteSampleItem({ id }, asOwner);
    expect((await grpcError(client.getSampleItem({ id }, asOwner))).code).toBe(status.NOT_FOUND);
  });

  it('maps the unique name constraint to ALREADY_EXISTS with a reason', async () => {
    await create('Lamp');
    const error = await grpcError(
      client.createSampleItem({ name: 'Lamp', description: '' }, asOwner),
    );
    expect(error.code).toBe(status.ALREADY_EXISTS);
    expect(error.details?.errorInfo?.reason).toBe('SAMPLE_ITEM_NAME_TAKEN');
  });

  it('rejects malformed input with field violations', async () => {
    const badId = await grpcError(client.getSampleItem({ id: 'not-a-uuid' }, asOwner));
    expect(badId.code).toBe(status.INVALID_ARGUMENT);
    expect(badId.details?.fieldViolations?.[0]?.field).toBe('id');

    const badName = await grpcError(
      client.createSampleItem({ name: '', description: '' }, asOwner),
    );
    expect(badName.details?.fieldViolations?.[0]?.field).toBe('name');
  });

  it('pages with opaque tokens, newest first', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) await create(name);
    const first = await client.listSampleItems({ pageSize: 2, pageToken: '' }, asOwner);
    expect(first.sampleItems.map((i) => i.name)).toEqual(['e', 'd']);
    const second = await client.listSampleItems(
      { pageSize: 2, pageToken: first.nextPageToken },
      asOwner,
    );
    expect(second.sampleItems.map((i) => i.name)).toEqual(['c', 'b']);
    const last = await client.listSampleItems(
      { pageSize: 2, pageToken: second.nextPageToken },
      asOwner,
    );
    expect(last.sampleItems.map((i) => i.name)).toEqual(['a']);
    expect(last.nextPageToken).toBe('');

    const garbage = await grpcError(
      client.listSampleItems({ pageSize: 2, pageToken: 'garbage' }, asOwner),
    );
    expect(garbage.code).toBe(status.INVALID_ARGUMENT);
  });

  it('serializes concurrent partial updates without losing either change', async () => {
    const id = await create('Lamp');
    await Promise.all([
      client.updateSampleItem({ id, name: 'Desk lamp' }, asOwner),
      client.updateSampleItem({ id, description: 'adjustable' }, asOwner),
    ]);
    await expect(client.getSampleItem({ id }, asOwner)).resolves.toMatchObject({
      sampleItem: { name: 'Desk lamp', description: 'adjustable' },
    });
  });

  /**
   * The five access cases every service keeps (ADR-0004, ga-testing). When you
   * reshape the template, adapt them; do not delete them.
   */
  describe('access', () => {
    it('1. refuses a call without a signed-in user', async () => {
      const error = await grpcError(client.listSampleItems({ pageSize: 10, pageToken: '' }));
      expect(error.code).toBe(status.UNAUTHENTICATED);
      expect(error.details?.errorInfo?.reason).toBe('PRINCIPAL_MISSING');
    });

    it('2. answers another user NOT_FOUND, as if the item did not exist', async () => {
      const id = await create('Lamp');
      const stranger = await service.as(STRANGER);
      for (const call of [
        async () => client.getSampleItem({ id }, stranger),
        async () => client.updateSampleItem({ id, name: 'Mine now' }, stranger),
        async () => client.deleteSampleItem({ id }, stranger),
      ]) {
        const error = await grpcError(call());
        expect(error.code).toBe(status.NOT_FOUND);
        expect(error.details?.errorInfo?.reason).toBe('SAMPLE_ITEM_NOT_FOUND');
      }
    });

    it("3. lets an admin read and change anyone's item", async () => {
      const id = await create('Lamp');
      const admin = await service.as(STRANGER, { roles: ['admin'] });
      await expect(client.getSampleItem({ id }, admin)).resolves.toBeDefined();
      await expect(
        client.updateSampleItem({ id, description: 'by admin' }, admin),
      ).resolves.toMatchObject({
        sampleItem: { description: 'by admin' },
      });
    });

    it("4. shows a stranger an empty list, and rejects the owner's page tokens", async () => {
      await create('a');
      await create('b');
      const first = await client.listSampleItems({ pageSize: 1, pageToken: '' }, asOwner);
      const stranger = await service.as(STRANGER);
      const theirs = await client.listSampleItems({ pageSize: 10, pageToken: '' }, stranger);
      expect(theirs.sampleItems).toHaveLength(0);
      const replayed = await grpcError(
        client.listSampleItems({ pageSize: 1, pageToken: first.nextPageToken }, stranger),
      );
      expect(replayed.code).toBe(status.INVALID_ARGUMENT);
    });

    it('5. refuses a user forwarded by a service this method does not list', async () => {
      const error = await grpcError(
        client.listSampleItems(
          { pageSize: 10, pageToken: '' },
          await service.as(OWNER, { caller: 'other-service' }),
        ),
      );
      expect(error.code).toBe(status.PERMISSION_DENIED);
      expect(error.details?.errorInfo?.reason).toBe('CALLER_NOT_ALLOWED');
    });
  });
});
