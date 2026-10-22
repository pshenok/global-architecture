import { z } from 'zod';

/**
 * Validation of inbound gRPC requests (shape and format). Business invariants
 * are enforced again by the domain; this layer turns bad input into precise
 * INVALID_ARGUMENT errors before any work is done.
 */
const id = z.uuid({ message: 'must be a UUID' });

export const CreateSampleItemRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000),
});

export const GetSampleItemRequestSchema = z.object({ id });

export const ListSampleItemsRequestSchema = z.object({
  pageSize: z.number().int().min(0),
  pageToken: z.string().max(512),
});

export const UpdateSampleItemRequestSchema = z.object({
  id,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
});

export const DeleteSampleItemRequestSchema = z.object({ id });
