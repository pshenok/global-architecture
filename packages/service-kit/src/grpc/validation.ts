import { type FieldViolation, ValidationError } from '@ga/kernel';
import type { z } from 'zod';

/**
 * Validates an inbound request (or any untrusted input) against a Zod schema and
 * returns the parsed value. Throws ValidationError (-> INVALID_ARGUMENT with
 * BadRequest field violations) listing every problem.
 */
export function parseRequest<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const violations: FieldViolation[] = result.error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    description: issue.message,
  }));
  const first = violations[0];
  const message = first
    ? `invalid ${first.field}: ${first.description}${violations.length > 1 ? ` (+${violations.length - 1} more)` : ''}`
    : 'invalid request';
  throw new ValidationError(message, violations);
}
