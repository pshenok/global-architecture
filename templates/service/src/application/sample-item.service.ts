import { Injectable } from '@nestjs/common';
import { Clock, IdGenerator, type Page, type PageRequest, UnitOfWork } from '@ga/kernel';
import { SampleItem, type SampleItemChanges } from '../domain/sample-item.ts';
import { sampleItemNotFound } from '../domain/sample-item.errors.ts';
import { SampleItemRepository } from '../domain/sample-item.repository.ts';

/**
 * Use cases of the sample item service. Orchestrates the domain through ports;
 * knows nothing about gRPC, SQL or the ORM.
 */
@Injectable()
export class SampleItemService {
  constructor(
    private readonly sampleItems: SampleItemRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async create(input: { name: string; description: string }): Promise<SampleItem> {
    const sampleItem = SampleItem.create({ id: this.ids.newId(), ...input }, this.clock.now());
    await this.sampleItems.insert(sampleItem);
    return sampleItem;
  }

  async get(id: string): Promise<SampleItem> {
    const sampleItem = await this.sampleItems.findById(id);
    if (!sampleItem) throw sampleItemNotFound(id);
    return sampleItem;
  }

  list(page: PageRequest): Promise<Page<SampleItem>> {
    return this.sampleItems.list(page);
  }

  /** Read-modify-write under a row lock, so concurrent partial updates never lose each other's changes. */
  update(id: string, changes: SampleItemChanges): Promise<SampleItem> {
    return this.unitOfWork.run(async () => {
      const sampleItem = await this.sampleItems.findById(id, { forUpdate: true });
      if (!sampleItem) throw sampleItemNotFound(id);
      sampleItem.update(changes, this.clock.now());
      await this.sampleItems.update(sampleItem);
      return sampleItem;
    });
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.sampleItems.delete(id);
    if (!deleted) throw sampleItemNotFound(id);
  }
}
