import { connect } from 'node:http2';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, BASE_URL, CA, day, raw, unique } from './client.ts';

/**
 * The whole system over the wire: HTTPS gateway -> gRPC services -> Postgres.
 * Run `pnpm stack:up` first.
 */
describe('global-architecture stack (e2e)', () => {
  let ownerId: string;
  let guestId: string;
  let houseId: string;

  beforeAll(async () => {
    const ready = await api('GET', '/readyz');
    expect(ready.status, `stack not ready: ${JSON.stringify(ready.body)}`).toBe(200);
  });

  it('serves HTTP/2 over TLS', async () => {
    const session = connect(BASE_URL, { ca: CA });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const stream = session.request({ ':path': '/healthz' });
        stream.on('response', (headers) => resolve(Number(headers[':status'])));
        stream.on('error', reject);
        stream.end();
      });
      expect(status).toBe(200);
      expect(session.alpnProtocol).toBe('h2');
    } finally {
      session.close();
    }
  });

  it('registers users and rejects a duplicate email with 409 USER_EMAIL_TAKEN', async () => {
    const email = `${unique('owner')}@example.com`;
    const owner = await api<{ id: string; email: string }>('POST', '/v1/users', {
      email,
      fullName: 'Olena Owner',
    });
    expect(owner.status).toBe(201);
    expect(owner.headers.location).toBe(`/v1/users/${owner.body.id}`);
    ownerId = owner.body.id;

    const guest = await api<{ id: string }>('POST', '/v1/users', {
      email: `${unique('guest')}@example.com`,
      fullName: 'Gleb Guest',
    });
    expect(guest.status).toBe(201);
    guestId = guest.body.id;

    const duplicate = await api('POST', '/v1/users', {
      email: email.toUpperCase(),
      fullName: 'Someone',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers['content-type']).toContain('application/problem+json');
    expect(duplicate.body).toMatchObject({ code: 'USER_EMAIL_TAKEN', domain: 'user-service' });
  });

  it('lists a house only for an existing owner (house-service -> user-service)', async () => {
    const house = await api<{ id: string; nightlyPrice: { amountMinor: number } }>(
      'POST',
      '/v1/houses',
      {
        ownerId,
        title: 'Loft by the sea',
        address: { line1: '1 Frantsuzky Blvd', city: 'Odesa', countryCode: 'UA' },
        nightlyPrice: { currencyCode: 'USD', amountMinor: 12_500 },
        maxGuests: 3,
      },
    );
    expect(house.status).toBe(201);
    houseId = house.body.id;

    const orphan = await api('POST', '/v1/houses', {
      ownerId: '01900000-0000-7000-8000-00000000dead',
      title: 'Nobody owns me',
      address: { line1: 'x', city: 'Kyiv', countryCode: 'UA' },
      nightlyPrice: { currencyCode: 'USD', amountMinor: 100 },
      maxGuests: 1,
    });
    expect(orphan.status).toBe(400);
    expect(orphan.body).toMatchObject({ code: 'HOUSE_OWNER_NOT_FOUND', domain: 'house-service' });
  });

  it('books, prices, prevents overlaps, cancels and rebooks (booking -> user + house)', async () => {
    const stay = { houseId, guestId, checkIn: day(30), checkOut: day(33), guests: 2 };
    const booking = await api<{ id: string; status: string; totalPrice: { amountMinor: number } }>(
      'POST',
      '/v1/bookings',
      stay,
    );
    expect(booking.status).toBe(201);
    expect(booking.body).toMatchObject({
      status: 'CONFIRMED',
      totalPrice: { currencyCode: 'USD', amountMinor: 37_500 },
    });

    const overlap = await api('POST', '/v1/bookings', {
      ...stay,
      checkIn: day(32),
      checkOut: day(35),
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body).toMatchObject({ code: 'BOOKING_DATES_UNAVAILABLE' });

    const backToBack = await api('POST', '/v1/bookings', {
      ...stay,
      checkIn: day(33),
      checkOut: day(34),
    });
    expect(backToBack.status).toBe(201);

    const crowded = await api('POST', '/v1/bookings', {
      ...stay,
      checkIn: day(40),
      checkOut: day(41),
      guests: 4,
    });
    expect(crowded.status).toBe(400);
    expect(crowded.body).toMatchObject({ code: 'BOOKING_TOO_MANY_GUESTS' });

    const cancelled = await api<{ status: string; cancelledAt: string }>(
      'POST',
      `/v1/bookings/${booking.body.id}/cancel`,
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const again = await api('POST', `/v1/bookings/${booking.body.id}/cancel`);
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ code: 'BOOKING_ALREADY_CANCELLED' });

    const rebooked = await api('POST', '/v1/bookings', stay);
    expect(rebooked.status).toBe(201);
  });

  it('lets exactly one of many concurrent requests for the same dates win', async () => {
    const stay = { houseId, guestId, checkIn: day(50), checkOut: day(52), guests: 1 };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => api('POST', '/v1/bookings', stay)),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
  });

  it('pages a filtered list with opaque tokens', async () => {
    const first = await api<{ items: { guestId: string }[]; nextPageToken: string | null }>(
      'GET',
      `/v1/bookings?guestId=${guestId}&pageSize=2`,
    );
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items.every((b) => b.guestId === guestId)).toBe(true);
    expect(first.body.nextPageToken).toBeTypeOf('string');

    const second = await api<{ items: unknown[] }>(
      'GET',
      `/v1/bookings?guestId=${guestId}&pageSize=2&pageToken=${encodeURIComponent(first.body.nextPageToken as string)}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.items.length).toBeGreaterThan(0);

    const tampered = await api(
      'GET',
      `/v1/bookings?houseId=${houseId}&pageSize=2&pageToken=${encodeURIComponent(first.body.nextPageToken as string)}`,
    );
    expect(tampered.status).toBe(400);
    expect(tampered.body).toMatchObject({ code: 'INVALID_PAGE_TOKEN' });
  });

  it('returns field-level validation errors and 404s as problem+json', async () => {
    const invalid = await api<{ errors: { field: string }[] }>('POST', '/v1/bookings', {
      houseId: 'nope',
      guestId,
      checkIn: '2026-02-30',
      checkOut: day(2),
      guests: 0,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors.map((e) => e.field)).toEqual(['houseId', 'checkIn', 'guests']);

    const missing = await api('GET', '/v1/houses/01900000-0000-7000-8000-00000000beef');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'HOUSE_NOT_FOUND', domain: 'house-service' });
  });

  it('propagates x-request-id end to end', async () => {
    const requestId = unique('e2e');
    const response = await api('GET', `/v1/users/${guestId}`, undefined, {
      'x-request-id': requestId,
    });
    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe(requestId);
  });

  it('serves the OpenAPI document and the docs UI', async () => {
    const document = await api<{ openapi: string; paths: Record<string, unknown> }>(
      'GET',
      '/openapi.json',
    );
    expect(document.body.openapi).toMatch(/^3\./);
    expect(Object.keys(document.body.paths)).toContain('/v1/bookings/{id}/cancel');
    const docs = await raw('/docs');
    expect(docs.status).toBe(200);
    expect(docs.contentType).toContain('text/html');
    expect(docs.text).toContain('Scalar API Reference');
  });
});
