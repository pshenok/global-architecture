import type { UserServiceClient } from '@ga/contracts/ga/user/v1/user';
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
import { USER_SERVICE } from '../clients.ts';
import { ProblemDetails } from '../http/problem-details.ts';
import { IdParam, nextToken, PageQuery } from '../http/schemas.ts';
import { CreateUserBody, toUserView, UpdateUserBody, UserPage, UserView } from './users.schemas.ts';

@ApiTags('users')
@ApiResponse({ status: 400, description: 'Invalid input', standardSchema: ProblemDetails })
@ApiResponse({
  status: 503,
  description: 'user-service unavailable',
  standardSchema: ProblemDetails,
})
@Controller('v1/users')
export class UsersController {
  constructor(@Inject(USER_SERVICE) private readonly users: UserServiceClient) {}

  @Post()
  @ApiOperation({ summary: 'Register a user' })
  @ApiResponse({ status: 201, standardSchema: UserView })
  @ApiResponse({
    status: 409,
    description: 'Email already registered (USER_EMAIL_TAKEN)',
    standardSchema: ProblemDetails,
  })
  async create(
    @Body({ schema: CreateUserBody }) body: z.output<typeof CreateUserBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { user } = await firstValueFrom(this.users.createUser(body));
    const view = toUserView(user);
    void reply.header('location', `/v1/users/${view.id}`);
    return view;
  }

  @Get()
  @ApiOperation({ summary: 'List users, newest first' })
  @ApiResponse({ status: 200, standardSchema: UserPage })
  async list(@Query({ schema: PageQuery }) query: z.output<typeof PageQuery>) {
    const page = await firstValueFrom(this.users.listUsers(query));
    return { items: page.users.map(toUserView), nextPageToken: nextToken(page.nextPageToken) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user' })
  @ApiResponse({ status: 200, standardSchema: UserView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async get(@Param('id', { schema: IdParam }) id: string) {
    return toUserView((await firstValueFrom(this.users.getUser({ id }))).user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a user (only the fields that are sent)' })
  @ApiResponse({ status: 200, standardSchema: UserView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  @ApiResponse({ status: 409, standardSchema: ProblemDetails })
  async update(
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: UpdateUserBody }) body: z.output<typeof UpdateUserBody>,
  ) {
    return toUserView((await firstValueFrom(this.users.updateUser({ id, ...body }))).user);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a user' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async remove(@Param('id', { schema: IdParam }) id: string): Promise<void> {
    await firstValueFrom(this.users.deleteUser({ id }));
  }
}
