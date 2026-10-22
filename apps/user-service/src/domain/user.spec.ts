import { ValidationError } from '@ga/kernel';
import { describe, expect, it } from 'vitest';
import { User } from './user.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-02T00:00:00.000Z');

describe('User', () => {
  it('lower-cases the email and trims the name', () => {
    const user = User.create({ id: 'u1', email: '  Ann@Example.COM ', fullName: ' Ann Lee ' }, now);
    expect(user.toState()).toEqual({
      id: 'u1',
      email: 'ann@example.com',
      fullName: 'Ann Lee',
      createdAt: now,
      updatedAt: now,
    });
  });

  it('rejects malformed emails and empty names', () => {
    expect(() => User.create({ id: 'u1', email: 'nope', fullName: 'Ann' }, now)).toThrow(
      ValidationError,
    );
    expect(() => User.create({ id: 'u1', email: 'a@b.io', fullName: '  ' }, now)).toThrow(
      ValidationError,
    );
  });

  it('updates the given fields only', () => {
    const user = User.create({ id: 'u1', email: 'a@b.io', fullName: 'Ann' }, now);
    user.update({ fullName: 'Ann Lee' }, later);
    expect(user.toState()).toMatchObject({
      email: 'a@b.io',
      fullName: 'Ann Lee',
      updatedAt: later,
    });
  });

  it('treats a case-only email change as no change', () => {
    const user = User.create({ id: 'u1', email: 'a@b.io', fullName: 'Ann' }, now);
    user.update({ email: 'A@B.IO' }, later);
    expect(user.updatedAt).toEqual(now);
  });
});
