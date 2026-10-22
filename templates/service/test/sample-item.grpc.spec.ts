import { fileURLToPath } from 'node:url';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SampleItemServiceClient } from '@ga/contracts/ga/sample_item/v1/sample_item';
import {
  createGrpcTestClient,
  createTestDatabase,
  type GrpcTestClient,
  grpcError,
  startTestService,
  type TestDatabase,
  type TestService,
} from '@ga/service-kit/testing';
import { AppModule } from '../src/app.module.ts';
import { SERVICE } from '../src/service.ts';

/**
 * End-to-end through the real stack: gRPC wire -> controller -> use case ->
 * Drizzle -> Postgres (an isolated schema with the real migrations).
 */
describe('SampleItemService over gRPC', () => {
  let db: TestDatabase;
  let service: TestService;
  let client: GrpcTestClient<SampleItemServiceClient>;

  beforeAll(async () => {
    db = await createTestDatabase({ migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    service = await startTestService({ module: AppModule, service: SERVICE, env: { DATABASE_URL: db.url } });
    client = createGrpcTestClient<SampleItemServiceClient>(SERVICE.services[0] as string, SERVICE.protoFiles, service.url);
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('sample_items'));

  it('creates, reads, updates and deletes', async () => {
    const { sampleItem } = await client.createSampleItem({ name: ' Lamp ', description: 'warm' });
    expect(sampleItem).toMatchObject({ name: 'Lamp', description: 'warm' });
    expect(sampleItem?.createTime).toBeInstanceOf(Date);
    const id = sampleItem?.id as string;

    await expect(client.getSampleItem({ id })).resolves.toMatchObject({ sampleItem: { id, name: 'Lamp' } });

    const updated = await client.updateSampleItem({ id, description: 'cold' });
    expect(updated.sampleItem).toMatchObject({ name: 'Lamp', description: 'cold' });

    await client.deleteSampleItem({ id });
    expect((await grpcError(client.getSampleItem({ id }))).code).toBe(status.NOT_FOUND);
  });

  it('maps the unique name constraint to ALREADY_EXISTS with a reason', async () => {
    await client.createSampleItem({ name: 'Lamp', description: '' });
    const error = await grpcError(client.createSampleItem({ name: 'Lamp', description: '' }));
    expect(error.code).toBe(status.ALREADY_EXISTS);
    expect(error.details?.errorInfo?.reason).toBe('SAMPLE_ITEM_NAME_TAKEN');
  });

  it('rejects malformed input with field violations', async () => {
    const badId = await grpcError(client.getSampleItem({ id: 'not-a-uuid' }));
    expect(badId.code).toBe(status.INVALID_ARGUMENT);
    expect(badId.details?.fieldViolations?.[0]?.field).toBe('id');

    const badName = await grpcError(client.createSampleItem({ name: '', description: '' }));
    expect(badName.details?.fieldViolations?.[0]?.field).toBe('name');
  });

  it('pages with opaque tokens, newest first', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) await client.createSampleItem({ name, description: '' });
    const first = await client.listSampleItems({ pageSize: 2, pageToken: '' });
    expect(first.sampleItems.map((i) => i.name)).toEqual(['e', 'd']);
    const second = await client.listSampleItems({ pageSize: 2, pageToken: first.nextPageToken });
    expect(second.sampleItems.map((i) => i.name)).toEqual(['c', 'b']);
    const last = await client.listSampleItems({ pageSize: 2, pageToken: second.nextPageToken });
    expect(last.sampleItems.map((i) => i.name)).toEqual(['a']);
    expect(last.nextPageToken).toBe('');

    const garbage = await grpcError(client.listSampleItems({ pageSize: 2, pageToken: 'garbage' }));
    expect(garbage.code).toBe(status.INVALID_ARGUMENT);
  });

  it('serializes concurrent partial updates without losing either change', async () => {
    const { sampleItem } = await client.createSampleItem({ name: 'Lamp', description: '' });
    const id = sampleItem?.id as string;
    await Promise.all([
      client.updateSampleItem({ id, name: 'Desk lamp' }),
      client.updateSampleItem({ id, description: 'adjustable' }),
    ]);
    await expect(client.getSampleItem({ id })).resolves.toMatchObject({
      sampleItem: { name: 'Desk lamp', description: 'adjustable' },
    });
  });
});
