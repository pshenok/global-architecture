import { z } from 'zod';

/** Validation of inbound gRPC requests (shape and format). The domain re-checks business rules. */
const id = z.uuid({ message: 'must be a UUID' });
const email = z.email({ message: 'must be a valid email address' }).max(254);
const fullName = z.string().trim().min(1).max(200);

export const RegisterUserRequestSchema = z.object({ fullName });

export const CreateUserRequestSchema = z.object({ email, fullName });

export const GetUserRequestSchema = z.object({ id });

export const ListUsersRequestSchema = z.object({
  pageSize: z.number().int().min(0),
  pageToken: z.string().max(512),
});

/** `email` is deprecated and ignored: the identity provider owns it. */
export const UpdateUserRequestSchema = z.object({
  id,
  fullName: fullName.optional(),
});

export const DeleteUserRequestSchema = z.object({ id });
