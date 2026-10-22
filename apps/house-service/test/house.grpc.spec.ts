import { fileURLToPath } from 'node:url';
import type { HouseServiceClient } from '@ga/contracts/ga/house/v1/house';
import {
  createGrpcTestClient,
  createTestDatabase,
  type GrpcTestClient,
  grpcError,
  startTestService,
  type TestDatabase,
  type TestService,
} from '@ga/service-kit/testing';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { UserDirectory } from '../src/application/ports/user-directory.ts';
import { SERVICE } from '../src/service.ts';
import { FakeUserDirectory, houseInput, OWNER_ID } from './fakes.ts';

/** Real gRPC + Postgres; the user-service dependency is replaced by a fake port. */
describe('HouseService over gRPC', () => {
  const users = new FakeUserDirectory(new Set([OWNER_ID]));
  let db: TestDatabase;
  let service: TestService;
  let client: GrpcTestClient<HouseServiceClient>;

  beforeAll(async () => {
    db = await createTestDatabase({
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    service = await startTestService({
      module: AppModule,
      service: SERVICE,
      env: { DATABASE_URL: db.url, USER_SERVICE_URL: '127.0.0.1:1' },
      override: (builder) => builder.overrideProvider(UserDirectory).useValue(users),
    });
    client = createGrpcTestClient<HouseServiceClient>(
      'ga.house.v1.HouseService',
      SERVICE.protoFiles,
      service.url,
    );
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('houses'));

  it('creates and reads a house with money and address intact', async () => {
    const { house } = await client.createHouse(houseInput());
    expect(house).toMatchObject({
      ownerId: OWNER_ID,
      address: { city: 'Odesa', countryCode: 'UA' },
      nightlyPrice: { currencyCode: 'USD', amountMinor: 12_000 },
      maxGuests: 4,
    });
    await expect(client.getHouse({ id: house?.id as string })).resolves.toMatchObject({
      house: { title: 'Sea view loft' },
    });
  });

  it('returns FAILED_PRECONDITION for an unknown owner', async () => {
    const error = await grpcError(
      client.createHouse(houseInput({ ownerId: '01900000-0000-7000-8000-0000000000ff' })),
    );
    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(error.details?.errorInfo?.reason).toBe('HOUSE_OWNER_NOT_FOUND');
  });

  it('updates nested values only when they are set', async () => {
    const { house } = await client.createHouse(houseInput());
    const id = house?.id as string;
    const updated = await client.updateHouse({ id, maxGuests: 6 });
    expect(updated.house).toMatchObject({
      maxGuests: 6,
      address: { city: 'Odesa' },
      nightlyPrice: { amountMinor: 12_000 },
    });
    const repriced = await client.updateHouse({
      id,
      nightlyPrice: { currencyCode: 'EUR', amountMinor: 9_900 },
    });
    expect(repriced.house?.nightlyPrice).toEqual({ currencyCode: 'EUR', amountMinor: 9_900 });
  });

  it('filters by city and binds page tokens to the filter', async () => {
    await client.createHouse(houseInput());
    await client.createHouse(
      houseInput({ address: { line1: '2 Main', city: 'Kyiv', countryCode: 'UA' } }),
    );
    await client.createHouse(
      houseInput({ address: { line1: '3 Main', city: 'kyiv', countryCode: 'UA' } }),
    );
    const page = await client.listHouses({ pageSize: 1, pageToken: '', city: 'KYIV' });
    expect(page.houses).toHaveLength(1);
    const next = await client.listHouses({
      pageSize: 1,
      pageToken: page.nextPageToken,
      city: 'KYIV',
    });
    expect(next.houses).toHaveLength(1);
    const mismatch = await grpcError(
      client.listHouses({ pageSize: 1, pageToken: page.nextPageToken, city: 'Odesa' }),
    );
    expect(mismatch.code).toBe(status.INVALID_ARGUMENT);
  });

  it('rejects invalid input with nested field paths', async () => {
    const error = await grpcError(
      client.createHouse(houseInput({ nightlyPrice: { currencyCode: 'usd', amountMinor: -5 } })),
    );
    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details?.fieldViolations?.map((v) => v.field)).toEqual([
      'nightlyPrice.currencyCode',
      'nightlyPrice.amountMinor',
    ]);
  });
});
