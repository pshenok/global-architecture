import type { RegisterUserResponse, UserServiceClient } from '@ga/contracts/ga/user/v1/user';
import { currentIdentity, currentUser } from '@ga/service-kit';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { firstValueFrom } from 'rxjs';
import type { z } from 'zod';
import { AllowUnregistered } from '../auth/decorators.ts';
import { IdentityResolver } from '../auth/identity-resolver.ts';
import { USER_SERVICE } from '../clients.ts';
import { ProblemDetails } from '../http/problem-details.ts';
import { nextToken, PageQuery } from '../http/schemas.ts';
import {
  RegisterUserBody,
  toUserView,
  UpdateUserBody,
  UserIdParam,
  UserPage,
  UserView,
} from './users.schemas.ts';

/** `me` -> the signed-in user's id. */
const userId = (id: string) => (id === 'me' ? currentUser().userId : id);

@ApiTags('users')
@ApiResponse({ status: 400, description: 'Invalid input', standardSchema: ProblemDetails })
@ApiResponse({
  status: 503,
  description: 'user-service unavailable',
  standardSchema: ProblemDetails,
})
@Controller('v1/users')
export class UsersController {
  constructor(
    @Inject(USER_SERVICE) private readonly users: UserServiceClient,
    private readonly identities: IdentityResolver,
  ) {}

  @Post()
  @AllowUnregistered()
  @ApiOperation({
    summary: 'Register the signed-in login as a new user',
    description: 'The email comes from the identity provider (per its email policy).',
  })
  @ApiResponse({ status: 201, standardSchema: UserView })
  @ApiResponse({
    status: 403,
    description: 'The identity provider has not verified an email (EMAIL_NOT_VERIFIED)',
    standardSchema: ProblemDetails,
  })
  @ApiResponse({
    status: 409,
    description: 'Already registered (USER_ALREADY_REGISTERED) or email taken (USER_EMAIL_TAKEN)',
    standardSchema: ProblemDetails,
  })
  async register(
    @Body({ schema: RegisterUserBody }) body: z.output<typeof RegisterUserBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { issuer, subject } = currentIdentity();
    let registered: RegisterUserResponse;
    try {
      registered = await firstValueFrom(this.users.registerUser(body));
    } finally {
      // Also on failure: USER_ALREADY_REGISTERED means a cached "not registered" is wrong.
      this.identities.forget({ issuer, subject });
    }
    const view = toUserView(registered.user);
    void reply.header('location', `/v1/users/${view.id}`);
    return view;
  }

  @Get()
  @ApiOperation({ summary: 'List users, newest first (admins only)' })
  @ApiResponse({ status: 200, standardSchema: UserPage })
  async list(@Query({ schema: PageQuery }) query: z.output<typeof PageQuery>) {
    const page = await firstValueFrom(this.users.listUsers(query));
    return { items: page.users.map(toUserView), nextPageToken: nextToken(page.nextPageToken) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user: yourself (`me`), or anyone if you are an admin' })
  @ApiResponse({ status: 200, standardSchema: UserView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async get(@Param('id', { schema: UserIdParam }) id: string) {
    return toUserView((await firstValueFrom(this.users.getUser({ id: userId(id) }))).user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a user (only the fields that are sent)' })
  @ApiResponse({ status: 200, standardSchema: UserView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async update(
    @Param('id', { schema: UserIdParam }) id: string,
    @Body({ schema: UpdateUserBody }) body: z.output<typeof UpdateUserBody>,
  ) {
    return toUserView(
      (await firstValueFrom(this.users.updateUser({ id: userId(id), ...body }))).user,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a user and its logins' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async remove(@Param('id', { schema: UserIdParam }) id: string): Promise<void> {
    const target = userId(id);
    try {
      await firstValueFrom(this.users.deleteUser({ id: target }));
    } finally {
      // Also when the call fails: the delete may have committed before a deadline.
      this.identities.forgetUser(target);
    }
  }
}
