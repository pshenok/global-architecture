import {
  Clock,
  IdGenerator,
  type Money,
  type Page,
  type PageRequest,
  UnitOfWork,
  type UserActor,
} from '@ga/kernel';
import { Injectable } from '@nestjs/common';
import { houseNotFound, ownerNotFound } from '../domain/house.errors.ts';
import { type HouseFilter, HouseRepository } from '../domain/house.repository.ts';
import { type Address, House, type HouseChanges } from '../domain/house.ts';
import { UserDirectory } from './ports/user-directory.ts';

export interface CreateHouseInput {
  readonly title: string;
  readonly description: string;
  readonly address: Address;
  readonly nightlyPrice: Money;
  readonly maxGuests: number;
}

/** Use cases of the house service. */
@Injectable()
export class HouseService {
  constructor(
    private readonly houses: HouseRepository,
    private readonly users: UserDirectory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  /**
   * Lists a house owned by the acting user. Validates the house first (cheap), then asks
   * user-service whether the owner's account still exists.
   */
  async create(actor: UserActor, input: CreateHouseInput): Promise<House> {
    const house = House.create(
      { id: this.ids.newId(), ownerId: actor.userId, ...input },
      this.clock.now(),
    );
    if (!(await this.users.exists(actor.userId))) throw ownerNotFound(actor.userId);
    await this.houses.insert(house);
    return house;
  }

  async get(id: string): Promise<House> {
    const house = await this.houses.findById(id);
    if (!house) throw houseNotFound(id);
    return house;
  }

  list(filter: HouseFilter, page: PageRequest): Promise<Page<House>> {
    return this.houses.list(filter, page);
  }

  update(actor: UserActor, id: string, changes: HouseChanges): Promise<House> {
    return this.unitOfWork.run(async () => {
      const house = await this.houses.findById(id, { forUpdate: true });
      if (!house) throw houseNotFound(id);
      house.assertManageableBy(actor);
      house.update(changes, this.clock.now());
      await this.houses.update(house);
      return house;
    });
  }

  /** Checks ownership under the row lock, so an ownership check and the delete cannot interleave. */
  delete(actor: UserActor, id: string): Promise<void> {
    return this.unitOfWork.run(async () => {
      const house = await this.houses.findById(id, { forUpdate: true });
      if (!house) throw houseNotFound(id);
      house.assertManageableBy(actor);
      await this.houses.delete(id);
    });
  }
}
