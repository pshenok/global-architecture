import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@ga/service-kit';
import { createTestDatabase } from '@ga/service-kit/testing';
import { describe, expect, it } from 'vitest';

const ALL = fileURLToPath(new URL('../drizzle', import.meta.url));

/** The host_id migration (ADR-0004) is dev-data-only: it must refuse populated tables loudly. */
describe('migrations', () => {
  it('refuses to add host_id to bookings from before ADR-0004, with a fix in the message', async () => {
    const before = mkdtempSync(join(tmpdir(), 'ga-booking-migrations-'));
    for (const entry of readdirSync(ALL).filter((name) => !name.endsWith('_host_id'))) {
      cpSync(join(ALL, entry), join(before, entry), { recursive: true });
    }
    const db = await createTestDatabase({ migrationsFolder: before });
    try {
      await db.pool.query(
        `insert into bookings (id, house_id, guest_id, check_in, check_out, guests, total_price_minor,
           currency_code, status, created_at, updated_at)
         values ('01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000002',
           '01900000-0000-7000-8000-000000000003', '2026-06-10', '2026-06-12', 1, 100, 'USD',
           'CONFIRMED', now(), now())`,
      );
      await expect(
        runMigrations({
          databaseUrl: db.url,
          migrationsFolder: ALL,
          lockKey: db.schema,
          migrationsSchema: db.schema,
        }),
      ).rejects.toThrow(/pnpm db:setup --reset ga_booking --yes/);
    } finally {
      await db.dispose();
      rmSync(before, { recursive: true, force: true });
    }
  });
});
