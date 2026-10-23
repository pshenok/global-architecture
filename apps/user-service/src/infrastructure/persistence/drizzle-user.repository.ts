import type { Role } from '@ga/kernel';
import { type Page, type PageRequest, toPage } from '@ga/kernel';
import { DbContext, translateDbError } from '@ga/service-kit';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, getTableColumns, lt } from 'drizzle-orm';
import { userAlreadyRegistered, userEmailTaken } from '../../domain/user.errors.ts';
import { type Identity, UserRepository } from '../../domain/user.repository.ts';
import { User } from '../../domain/user.ts';
import { type UserRow, userIdentities, users } from './schema.ts';

/** Roles outside this version's list cannot be stored (users_roles_check), so the cast is safe. */
const toDomain = (row: UserRow): User => User.restore({ ...row, roles: row.roles as Role[] });
const toRow = (user: User): UserRow => ({ ...user.toState(), roles: [...user.roles] });

/** Drizzle adapter of the UserRepository port. */
@Injectable()
export class DrizzleUserRepository extends UserRepository {
  constructor(private readonly db: DbContext) {
    super();
  }

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<User | null> {
    const query = this.db.tx.select().from(users).where(eq(users.id, id));
    const rows = options.forUpdate ? await query.for('update') : await query;
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async list({ limit, after }: PageRequest): Promise<Page<User>> {
    const rows = await this.db.tx
      .select()
      .from(users)
      .where(after ? lt(users.id, after) : undefined)
      .orderBy(desc(users.id))
      .limit(limit + 1);
    return toPage(rows.map(toDomain), limit);
  }

  async insert(user: User): Promise<void> {
    try {
      await this.db.tx.insert(users).values(toRow(user));
    } catch (error) {
      throw translateDbError(error, { users_email_key: () => userEmailTaken(user.email) });
    }
  }

  async update(user: User): Promise<void> {
    const { id, ...state } = toRow(user);
    try {
      await this.db.tx.update(users).set(state).where(eq(users.id, id));
    } catch (error) {
      throw translateDbError(error, { users_email_key: () => userEmailTaken(user.email) });
    }
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.tx.delete(users).where(eq(users.id, id)).returning({ id: users.id });
    return rows.length > 0;
  }

  async findByIdentity({ issuer, subject }: Identity): Promise<User | null> {
    const rows = await this.db.tx
      .select(getTableColumns(users))
      .from(userIdentities)
      .innerJoin(users, eq(users.id, userIdentities.userId))
      .where(and(eq(userIdentities.issuer, issuer), eq(userIdentities.subject, subject)));
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async linkIdentity(userId: string, { issuer, subject }: Identity, now: Date): Promise<void> {
    try {
      await this.db.tx.insert(userIdentities).values({ issuer, subject, userId, createdAt: now });
    } catch (error) {
      throw translateDbError(error, { user_identities_pkey: () => userAlreadyRegistered() });
    }
  }
}
