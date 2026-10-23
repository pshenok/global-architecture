import { fileURLToPath } from 'node:url';
import type { HouseServiceClient } from '@ga/contracts/ga/house/v1/house';
import {
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
import { FakeUserDirectory, houseRequest, OWNER_ID } from './fakes.ts';

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
    client = service.client<HouseServiceClient>('ga.house.v1.HouseService');
  });

  afterAll(async () => {
    client?.close();
    await service?.close();
    await db?.dispose();
  });

  beforeEach(() => db.truncate('houses'));

  it('creates and reads a house with money and address intact', async () => {
    const { house } = await client.createHouse(houseRequest(), await service.as(OWNER_ID));
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

  it("returns FAILED_PRECONDITION when the owner's account is gone", async () => {
    const error = await grpcError(
      client.createHouse(houseRequest(), await service.as('01900000-0000-7000-8000-0000000000ff')),
    );
    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(error.details?.errorInfo?.reason).toBe('HOUSE_OWNER_NOT_FOUND');
  });

  it('updates nested values only when they are set', async () => {
    const { house } = await client.createHouse(houseRequest(), await service.as(OWNER_ID));
    const id = house?.id as string;
    const updated = await client.updateHouse({ id, maxGuests: 6 }, await service.as(OWNER_ID));
    expect(updated.house).toMatchObject({
      maxGuests: 6,
      address: { city: 'Odesa' },
      nightlyPrice: { amountMinor: 12_000 },
    });
    const repriced = await client.updateHouse(
      { id, nightlyPrice: { currencyCode: 'EUR', amountMinor: 9_900 } },
      await service.as(OWNER_ID),
    );
    expect(repriced.house?.nightlyPrice).toEqual({ currencyCode: 'EUR', amountMinor: 9_900 });
  });

  it('filters by city and binds page tokens to the filter', async () => {
    await client.createHouse(houseRequest(), await service.as(OWNER_ID));
    await client.createHouse(
      houseRequest({ address: { line1: '2 Main', city: 'Kyiv', countryCode: 'UA' } }),
      await service.as(OWNER_ID),
    );
    await client.createHouse(
      houseRequest({ address: { line1: '3 Main', city: 'kyiv', countryCode: 'UA' } }),
      await service.as(OWNER_ID),
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
      client.createHouse(
        houseRequest({ nightlyPrice: { currencyCode: 'usd', amountMinor: -5 } }),
        await service.as(OWNER_ID),
      ),
    );
    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details?.fieldViolations?.map((v) => v.field)).toEqual([
      'nightlyPrice.currencyCode',
      'nightlyPrice.amountMinor',
    ]);
  });

  describe('access', () => {
    const STRANGER = '01900000-0000-7000-8000-0000000000bb';
    const create = async () =>
      (await client.createHouse(houseRequest(), await service.as(OWNER_ID))).house?.id as string;

    it('takes the owner from the principal, never from the request', async () => {
      const { house } = await client.createHouse(
        houseRequest({ ownerId: STRANGER }),
        await service.as(OWNER_ID),
      );
      expect(house?.ownerId).toBe(OWNER_ID);
    });

    it('lets anyone read the catalogue, signed in or not', async () => {
      const id = await create();
      await expect(client.getHouse({ id })).resolves.toMatchObject({ house: { id } });
      await expect(client.getHouse({ id }, await service.as(STRANGER))).resolves.toBeDefined();
    });

    it('needs a signed-in user to create, change or delete', async () => {
      const id = await create();
      for (const call of [
        async () => client.createHouse(houseRequest()),
        async () => client.updateHouse({ id, maxGuests: 2 }),
        async () => client.deleteHouse({ id }),
      ]) {
        const error = await grpcError(call());
        expect(error.code).toBe(status.UNAUTHENTICATED);
        expect(error.details?.errorInfo?.reason).toBe('PRINCIPAL_MISSING');
      }
    });

    it('lets only the owner or an admin change or delete a house', async () => {
      const id = await create();
      for (const call of [
        async () => client.updateHouse({ id, maxGuests: 2 }, await service.as(STRANGER)),
        async () => client.deleteHouse({ id }, await service.as(STRANGER)),
      ]) {
        const error = await grpcError(call());
        expect(error.code).toBe(status.PERMISSION_DENIED);
        expect(error.details?.errorInfo?.reason).toBe('HOUSE_PERMISSION_DENIED');
      }
      const admin = await service.as(STRANGER, { roles: ['admin'] });
      await expect(client.updateHouse({ id, maxGuests: 2 }, admin)).resolves.toMatchObject({
        house: { maxGuests: 2 },
      });
      await client.deleteHouse({ id }, await service.as(OWNER_ID));
      expect((await grpcError(client.getHouse({ id }))).code).toBe(status.NOT_FOUND);
    });
  });
});
