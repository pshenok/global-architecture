import type { HouseServiceClient } from '@ga/contracts/ga/house/v1/house';
import { currentUser } from '@ga/service-kit';
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
import { Public } from '../auth/decorators.ts';
import { HOUSE_SERVICE } from '../clients.ts';
import { ProblemDetails } from '../http/problem-details.ts';
import { IdParam, nextToken, PageQuery } from '../http/schemas.ts';
import {
  CreateHouseBody,
  HousePage,
  HouseQuery,
  HouseView,
  toHouseView,
  UpdateHouseBody,
} from './houses.schemas.ts';

const ListHousesQuery = PageQuery.extend(HouseQuery.shape);

@ApiTags('houses')
@ApiResponse({ status: 400, description: 'Invalid input', standardSchema: ProblemDetails })
@ApiResponse({
  status: 503,
  description: 'A service is unavailable',
  standardSchema: ProblemDetails,
})
@Controller('v1/houses')
export class HousesController {
  constructor(@Inject(HOUSE_SERVICE) private readonly houses: HouseServiceClient) {}

  @Post()
  @ApiOperation({ summary: 'List a house; the signed-in user becomes its owner' })
  @ApiResponse({ status: 201, standardSchema: HouseView })
  async create(
    @Body({ schema: CreateHouseBody }) body: z.output<typeof CreateHouseBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const request = { ...body, ownerId: currentUser().userId };
    const view = toHouseView((await firstValueFrom(this.houses.createHouse(request))).house);
    void reply.header('location', `/v1/houses/${view.id}`);
    return view;
  }

  @Get()
  @Public('world-readable catalogue')
  @ApiOperation({ summary: 'List houses, newest first, optionally by owner or city' })
  @ApiResponse({ status: 200, standardSchema: HousePage })
  async list(@Query({ schema: ListHousesQuery }) query: z.output<typeof ListHousesQuery>) {
    const page = await firstValueFrom(this.houses.listHouses(query));
    return { items: page.houses.map(toHouseView), nextPageToken: nextToken(page.nextPageToken) };
  }

  @Get(':id')
  @Public('world-readable catalogue')
  @ApiOperation({ summary: 'Get a house' })
  @ApiResponse({ status: 200, standardSchema: HouseView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async get(@Param('id', { schema: IdParam }) id: string) {
    return toHouseView((await firstValueFrom(this.houses.getHouse({ id }))).house);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change your house (only the fields that are sent)' })
  @ApiResponse({ status: 200, standardSchema: HouseView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async update(
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: UpdateHouseBody }) body: z.output<typeof UpdateHouseBody>,
  ) {
    const { address, nightlyPrice, ...fields } = body;
    const request = {
      id,
      ...fields,
      ...(address ? { address } : {}),
      ...(nightlyPrice ? { nightlyPrice } : {}),
    };
    return toHouseView((await firstValueFrom(this.houses.updateHouse(request))).house);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete your house' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async remove(@Param('id', { schema: IdParam }) id: string): Promise<void> {
    await firstValueFrom(this.houses.deleteHouse({ id }));
  }
}
