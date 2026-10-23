import {
  Clock,
  ConflictError,
  type IdentityActor,
  IdGenerator,
  type Page,
  type PageRequest,
  type Role,
  UnitOfWork,
} from '@ga/kernel';
import { Injectable } from '@nestjs/common';
import { userAlreadyRegistered, userNotFound, userNotRegistered } from '../domain/user.errors.ts';
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

  /**
   * Registers the calling identity as a new user, with the email the gateway accepted
   * from the identity provider. Uniqueness of email and identity is enforced by
   * constraints; when two registrations race, the loser learns which one it lost.
   */
  async register(actor: IdentityActor, input: { fullName: string }): Promise<User> {
    const now = this.clock.now();
    const user = User.create(
      { id: this.ids.newId(), email: actor.email, fullName: input.fullName },
      now,
    );
    const identity = { issuer: actor.issuer, subject: actor.subject };
    try {
      await this.unitOfWork.run(async () => {
        await this.users.insert(user);
        await this.users.linkIdentity(user.id, identity, now);
      });
    } catch (error) {
      // A concurrent registration of the same identity commits its user first, so this
      // one fails on the email. Report what really happened: the identity is taken.
      if (
        error instanceof ConflictError &&
        error.reason === 'USER_EMAIL_TAKEN' &&
        (await this.users.findByIdentity(identity))
      ) {
        throw userAlreadyRegistered();
      }
      throw error;
    }
    return user;
  }

  /** The user and roles of the calling identity. */
  async resolve(actor: IdentityActor): Promise<{ userId: string; roles: readonly Role[] }> {
    const user = await this.users.findByIdentity({ issuer: actor.issuer, subject: actor.subject });
    if (!user) throw userNotRegistered();
    return { userId: user.id, roles: user.roles };
  }

  /** Transitional (ADR-0004 rollout): registration without an identity. */
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
