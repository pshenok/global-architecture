import { ConflictError, NotFoundError } from '@ga/kernel';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemoryUserRepository,
  PassThroughUnitOfWork,
  SequentialIds,
} from '../../test/fakes.ts';
import { UserService } from './user.service.ts';

describe('UserService', () => {
  let service: UserService;
  let clock: FixedClock;

  beforeEach(() => {
    clock = new FixedClock();
    service = new UserService(
      new InMemoryUserRepository(),
      new SequentialIds(),
      clock,
      new PassThroughUnitOfWork(),
    );
  });

  it('registers and reads back a user', async () => {
    const user = await service.create({ email: 'Ann@Example.com', fullName: 'Ann' });
    await expect(service.get(user.id)).resolves.toMatchObject({ email: 'ann@example.com' });
  });

  it('rejects an email that is already registered, regardless of case', async () => {
    await service.create({ email: 'ann@example.com', fullName: 'Ann' });
    await expect(
      service.create({ email: 'ANN@example.com', fullName: 'Other' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('pages newest first', async () => {
    for (const n of ['a', 'b', 'c']) await service.create({ email: `${n}@x.io`, fullName: n });
    const first = await service.list({ limit: 2, after: null });
    expect(first.items.map((u) => u.fullName)).toEqual(['c', 'b']);
    const second = await service.list({ limit: 2, after: first.nextAfter });
    expect(second.items.map((u) => u.fullName)).toEqual(['a']);
  });

  it('updates with a new timestamp', async () => {
    const user = await service.create({ email: 'a@x.io', fullName: 'A' });
    clock.advance(1_000);
    const updated = await service.update(user.id, { fullName: 'Ann' });
    expect(updated.updatedAt.getTime()).toBe(user.createdAt.getTime() + 1_000);
  });

  it('reports NOT_FOUND for unknown ids', async () => {
    await expect(service.get('missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.delete('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
