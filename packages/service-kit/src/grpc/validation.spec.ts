import { ValidationError } from '@ga/kernel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseRequest } from './validation.ts';

const schema = z.object({ email: z.email(), fullName: z.string().trim().min(1).max(200) });

describe('parseRequest', () => {
  it('returns parsed (transformed) data', () => {
    expect(parseRequest(schema, { email: 'a@b.io', fullName: '  Ann ' })).toEqual({
      email: 'a@b.io',
      fullName: 'Ann',
    });
  });

  it('throws ValidationError listing every violation with camelCase field paths', () => {
    let caught: unknown;
    try {
      parseRequest(schema, { email: 'nope', fullName: '' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    expect(error.violations.map((v) => v.field)).toEqual(['email', 'fullName']);
    expect(error.message).toMatch(/^invalid email: .* \(\+1 more\)$/);
  });
});
