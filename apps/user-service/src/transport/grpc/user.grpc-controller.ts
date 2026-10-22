import {
  type CreateUserRequest,
  type CreateUserResponse,
  type DeleteUserRequest,
  type DeleteUserResponse,
  type GetUserRequest,
  type GetUserResponse,
  type ListUsersRequest,
  type ListUsersResponse,
  type UpdateUserRequest,
  type UpdateUserResponse,
  type UserServiceController,
  UserServiceControllerMethods,
} from '@ga/contracts/ga/user/v1/user';
import { decodePageToken, encodePageToken, filterFingerprint, resolvePageSize } from '@ga/kernel';
import { parseRequest } from '@ga/service-kit';
import { Controller } from '@nestjs/common';
import { UserService } from '../../application/user.service.ts';
import { toUserMessage } from './user.mapper.ts';
import {
  CreateUserRequestSchema,
  DeleteUserRequestSchema,
  GetUserRequestSchema,
  ListUsersRequestSchema,
  UpdateUserRequestSchema,
} from './user.requests.ts';

/**
 * gRPC adapter: validate the request, call one use case, map the result.
 * No business logic here. Errors thrown below become gRPC statuses in the
 * service kit's GrpcErrorFilter.
 */
@Controller()
@UserServiceControllerMethods()
export class UserGrpcController implements UserServiceController {
  constructor(private readonly users: UserService) {}

  async createUser(request: CreateUserRequest): Promise<CreateUserResponse> {
    const input = parseRequest(CreateUserRequestSchema, request);
    return { user: toUserMessage(await this.users.create(input)) };
  }

  async getUser(request: GetUserRequest): Promise<GetUserResponse> {
    const { id } = parseRequest(GetUserRequestSchema, request);
    return { user: toUserMessage(await this.users.get(id)) };
  }

  async listUsers(request: ListUsersRequest): Promise<ListUsersResponse> {
    const { pageSize, pageToken } = parseRequest(ListUsersRequestSchema, request);
    const fingerprint = filterFingerprint({});
    const page = await this.users.list({
      limit: resolvePageSize(pageSize),
      after: decodePageToken(pageToken, fingerprint),
    });
    return {
      users: page.items.map(toUserMessage),
      nextPageToken: page.nextAfter ? encodePageToken(page.nextAfter, fingerprint) : '',
    };
  }

  async updateUser(request: UpdateUserRequest): Promise<UpdateUserResponse> {
    const { id, ...changes } = parseRequest(UpdateUserRequestSchema, request);
    return { user: toUserMessage(await this.users.update(id, changes)) };
  }

  async deleteUser(request: DeleteUserRequest): Promise<DeleteUserResponse> {
    const { id } = parseRequest(DeleteUserRequestSchema, request);
    await this.users.delete(id);
    return {};
  }
}
