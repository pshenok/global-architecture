import type { UserServiceClient } from '@ga/contracts/ga/user/v1/user';
import { grpcStatusOf, toDependencyError } from '@ga/service-kit';
import { status } from '@grpc/grpc-js';
import { Inject, Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { UserDirectory } from '../../application/ports/user-directory.ts';
import { USER_SERVICE } from './dependency-clients.ts';

/** UserDirectory backed by user-service over gRPC. */
@Injectable()
export class GrpcUserDirectory extends UserDirectory {
  constructor(@Inject(USER_SERVICE) private readonly users: UserServiceClient) {
    super();
  }

  async exists(userId: string): Promise<boolean> {
    try {
      await firstValueFrom(this.users.getUser({ id: userId }));
      return true;
    } catch (error) {
      if (grpcStatusOf(error) === status.NOT_FOUND) return false;
      throw toDependencyError(error, 'user-service');
    }
  }
}
