import { z } from 'zod';

/** Shared REST building blocks. */
export const IdParam = z.uuid({ message: 'must be a UUID' });

export const PageQuery = z.object({
  pageSize: z.coerce
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(0)
    .describe('1..100; 0 or omitted = 20.'),
  pageToken: z.string().max(512).default('').describe('nextPageToken of the previous page.'),
});

export const MoneyView = z
  .object({
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .describe('ISO 4217, e.g. USD'),
    amountMinor: z.number().int().nonnegative().describe('Minor units, e.g. 12550 = 125.50 USD'),
  })
  .meta({ id: 'Money' });

/** `{ items, nextPageToken }` envelope of every list endpoint. */
export const pageOf = <T extends z.ZodType>(item: T, id: string) =>
  z
    .object({
      items: z.array(item),
      nextPageToken: z
        .string()
        .nullable()
        .describe('Pass as pageToken to get the next page; null on the last page.'),
    })
    .meta({ id });

export function iso(value: Date | null | undefined): string {
  if (!value) throw new Error('missing timestamp in a downstream response');
  return value.toISOString();
}

export function nextToken(token: string): string | null {
  return token === '' ? null : token;
}
