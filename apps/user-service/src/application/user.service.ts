import { Clock, IdGenerator, type Page, type PageRequest, UnitOfWork } from '@ga/kernel';
import { Injectable } from '@nestjs/common';
import { userNotFound } from '../domain/user.errors.ts';
import { UserRepository } from '../domain/user.repository.ts';
import { User, type UserChanges } from '../domain/user.ts';

/** Use cases of the user service. */
@Injectable()
export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  /** Email uniqueness is enforced by the database constraint, not by a racy pre-check. */
  async create(input: { email: string; fullName: string }): Promise<User> {
    const user = User.create({ id: this.ids.newId(), ...input }, this.clock.now());
    await this.users.insert(user);
    return user;
  }

  async get(id: string): Promise<User> {
    const user = await this.users.findById(id);
    if (!user) throw userNotFound(id);
    return user;
  }

  list(page: PageRequest): Promise<Page<User>> {
    return this.users.list(page);
  }

  /** Read-modify-write under a row lock, so concurrent partial updates never lose each other's changes. */
  update(id: string, changes: UserChanges): Promise<User> {
    return this.unitOfWork.run(async () => {
      const user = await this.users.findById(id, { forUpdate: true });
      if (!user) throw userNotFound(id);
      user.update(changes, this.clock.now());
      await this.users.update(user);
      return user;
    });
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.users.delete(id);
    if (!deleted) throw userNotFound(id);
  }
}
