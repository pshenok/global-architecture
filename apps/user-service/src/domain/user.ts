import { ValidationError } from '@ga/kernel';

/** Persisted state of a User. */
export interface UserState {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UserChanges {
  readonly email?: string | undefined;
  readonly fullName?: string | undefined;
}

export const EMAIL_MAX = 254;
export const FULL_NAME_MAX = 200;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Emails are compared case-insensitively, so they are stored lower-cased. */
function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > EMAIL_MAX || !EMAIL_SHAPE.test(normalized)) {
    throw new ValidationError('email must be a valid address', [
      { field: 'email', description: 'must be a valid email address' },
    ]);
  }
  return normalized;
}

function normalizeFullName(fullName: string): string {
  const trimmed = fullName.trim();
  if (trimmed.length === 0 || trimmed.length > FULL_NAME_MAX) {
    throw new ValidationError(`fullName must be 1..${FULL_NAME_MAX} characters`, [
      { field: 'fullName', description: `must be 1..${FULL_NAME_MAX} characters` },
    ]);
  }
  return trimmed;
}

/** User aggregate: an account on the platform. */
export class User {
  private constructor(private state: UserState) {}

  static create(input: { id: string; email: string; fullName: string }, now: Date): User {
    return new User({
      id: input.id,
      email: normalizeEmail(input.email),
      fullName: normalizeFullName(input.fullName),
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(state: UserState): User {
    return new User({ ...state });
  }

  get id(): string {
    return this.state.id;
  }

  get email(): string {
    return this.state.email;
  }

  get fullName(): string {
    return this.state.fullName;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  /** Applies the given changes; fields left undefined stay as they are. */
  update(changes: UserChanges, now: Date): void {
    const email = changes.email === undefined ? this.state.email : normalizeEmail(changes.email);
    const fullName =
      changes.fullName === undefined ? this.state.fullName : normalizeFullName(changes.fullName);
    if (email === this.state.email && fullName === this.state.fullName) return;
    this.state = { ...this.state, email, fullName, updatedAt: now };
  }

  toState(): UserState {
    return { ...this.state };
  }
}
