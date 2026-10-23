import type { UserServiceClient } from '@ga/contracts/ga/user/v1/user';
import type { UserActor } from '@ga/kernel';
import { grpcStatusOf, toDependencyError } from '@ga/service-kit';
import { status } from '@grpc/grpc-js';
import { Inject, Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { UserDirectory } from '../../application/ports/user-directory.ts';
import { USER_SERVICE } from './user-service.client.ts';

/** UserDirectory backed by user-service over gRPC. */
@Injectable()
export class GrpcUserDirectory extends UserDirectory {
  constructor(@Inject(USER_SERVICE) private readonly users: UserServiceClient) {
    super();
  }

  async stillExists(actor: UserActor): Promise<boolean> {
    try {
      await firstValueFrom(this.users.getUser({ id: actor.userId }));
      return true;
    } catch (error) {
      if (grpcStatusOf(error) === status.NOT_FOUND) return false;
      throw toDependencyError(error, 'user-service');
    }
  }
}
