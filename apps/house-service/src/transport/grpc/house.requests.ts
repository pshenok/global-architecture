import { z } from 'zod';

/** Validation of inbound gRPC requests. Unset message fields arrive as null (proto-loader). */
const id = z.uuid({ message: 'must be a UUID' });

const AddressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  countryCode: z.string().regex(/^[A-Za-z]{2}$/, 'must be an ISO 3166-1 alpha-2 code'),
});

const MoneySchema = z.object({
  currencyCode: z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code like USD'),
  amountMinor: z.number().int().positive(),
});

/** `owner_id` is deprecated and ignored: the owner is the calling user. */
export const CreateHouseRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000),
  address: AddressSchema,
  nightlyPrice: MoneySchema,
  maxGuests: z.number().int().min(1).max(50),
});

export const GetHouseRequestSchema = z.object({ id });

export const ListHousesRequestSchema = z.object({
  pageSize: z.number().int().min(0),
  pageToken: z.string().max(512),
  ownerId: id.optional(),
  city: z.string().trim().min(1).max(100).optional(),
});

export const UpdateHouseRequestSchema = z.object({
  id,
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  address: AddressSchema.nullish().transform((v) => v ?? undefined),
  nightlyPrice: MoneySchema.nullish().transform((v) => v ?? undefined),
  maxGuests: z.number().int().min(1).max(50).optional(),
});

export const DeleteHouseRequestSchema = z.object({ id });
