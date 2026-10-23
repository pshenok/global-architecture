import { ConflictError, NotFoundError } from '@ga/kernel';
import { identityActor } from '@ga/kernel/testing';
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

  const ann = identityActor('https://idp.example', 'ann-sub', 'Ann@Example.com');

  it('registers an identity once and resolves it to its user', async () => {
    const user = await service.register(ann, { fullName: 'Ann' });
    expect(user.toState()).toMatchObject({ email: 'ann@example.com', roles: [] });
    await expect(service.resolve(ann)).resolves.toEqual({ userId: user.id, roles: [] });
    const again = await service.register(ann, { fullName: 'Ann' }).catch((e: unknown) => e);
    expect(again).toMatchObject({ reason: 'USER_ALREADY_REGISTERED' });
  });

  it('keeps identities of different issuers apart, even with the same subject', async () => {
    const other = identityActor('https://other-idp.example', 'ann-sub', null);
    const first = await service.register(ann, { fullName: 'Ann' });
    const second = await service.register(other, { fullName: 'Ann too' });
    expect(first.id).not.toBe(second.id);
    await expect(service.resolve(other)).resolves.toMatchObject({ userId: second.id });
  });

  it('rejects another identity with an email that is taken', async () => {
    await service.register(ann, { fullName: 'Ann' });
    const imposter = identityActor('https://idp.example', 'other-sub', 'ann@example.com');
    await expect(service.register(imposter, { fullName: 'X' })).rejects.toMatchObject({
      reason: 'USER_EMAIL_TAKEN',
    });
  });

  it('reports an unregistered identity as USER_NOT_REGISTERED', async () => {
    await expect(service.resolve(ann)).rejects.toMatchObject({ reason: 'USER_NOT_REGISTERED' });
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
