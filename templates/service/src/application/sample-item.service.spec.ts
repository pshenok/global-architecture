import { ConflictError, NotFoundError } from '@ga/kernel';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemorySampleItemRepository,
  PassThroughUnitOfWork,
  SequentialIds,
} from '../../test/fakes.ts';
import { SampleItemService } from './sample-item.service.ts';

describe('SampleItemService', () => {
  let repository: InMemorySampleItemRepository;
  let clock: FixedClock;
  let service: SampleItemService;

  beforeEach(() => {
    repository = new InMemorySampleItemRepository();
    clock = new FixedClock();
    service = new SampleItemService(
      repository,
      new SequentialIds(),
      clock,
      new PassThroughUnitOfWork(),
    );
  });

  it('creates and reads back a sample item', async () => {
    const created = await service.create({ name: 'Lamp', description: '' });
    await expect(service.get(created.id)).resolves.toMatchObject({ name: 'Lamp' });
  });

  it('rejects a duplicate name', async () => {
    await service.create({ name: 'Lamp', description: '' });
    await expect(service.create({ name: 'Lamp', description: 'again' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('pages newest first', async () => {
    for (const name of ['a', 'b', 'c']) await service.create({ name, description: '' });
    const first = await service.list({ limit: 2, after: null });
    expect(first.items.map((i) => i.name)).toEqual(['c', 'b']);
    const second = await service.list({ limit: 2, after: first.nextAfter });
    expect(second.items.map((i) => i.name)).toEqual(['a']);
    expect(second.nextAfter).toBeNull();
  });

  it('updates with a new timestamp', async () => {
    const created = await service.create({ name: 'Lamp', description: '' });
    clock.advance(1_000);
    const updated = await service.update(created.id, { description: 'warm' });
    expect(updated.description).toBe('warm');
    expect(updated.updatedAt.getTime()).toBe(created.createdAt.getTime() + 1_000);
  });

  it('reports NOT_FOUND for unknown ids', async () => {
    await expect(service.get('missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.update('missing', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.delete('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
