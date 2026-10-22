import {
  type CreateHouseRequest,
  type CreateHouseResponse,
  type DeleteHouseRequest,
  type DeleteHouseResponse,
  type GetHouseRequest,
  type GetHouseResponse,
  type HouseServiceController,
  HouseServiceControllerMethods,
  type ListHousesRequest,
  type ListHousesResponse,
  type UpdateHouseRequest,
  type UpdateHouseResponse,
} from '@ga/contracts/ga/house/v1/house';
import { decodePageToken, encodePageToken, filterFingerprint, resolvePageSize } from '@ga/kernel';
import { parseRequest } from '@ga/service-kit';
import { Controller } from '@nestjs/common';
import { HouseService } from '../../application/house.service.ts';
import { toHouseMessage } from './house.mapper.ts';
import {
  CreateHouseRequestSchema,
  DeleteHouseRequestSchema,
  GetHouseRequestSchema,
  ListHousesRequestSchema,
  UpdateHouseRequestSchema,
} from './house.requests.ts';

/** gRPC adapter of the house service. */
@Controller()
@HouseServiceControllerMethods()
export class HouseGrpcController implements HouseServiceController {
  constructor(private readonly houses: HouseService) {}

  async createHouse(request: CreateHouseRequest): Promise<CreateHouseResponse> {
    const input = parseRequest(CreateHouseRequestSchema, request);
    return { house: toHouseMessage(await this.houses.create(input)) };
  }

  async getHouse(request: GetHouseRequest): Promise<GetHouseResponse> {
    const { id } = parseRequest(GetHouseRequestSchema, request);
    return { house: toHouseMessage(await this.houses.get(id)) };
  }

  async listHouses(request: ListHousesRequest): Promise<ListHousesResponse> {
    const { pageSize, pageToken, ownerId, city } = parseRequest(ListHousesRequestSchema, request);
    const filter = { ownerId, city };
    const fingerprint = filterFingerprint(filter);
    const page = await this.houses.list(filter, {
      limit: resolvePageSize(pageSize),
      after: decodePageToken(pageToken, fingerprint),
    });
    return {
      houses: page.items.map(toHouseMessage),
      nextPageToken: page.nextAfter ? encodePageToken(page.nextAfter, fingerprint) : '',
    };
  }

  async updateHouse(request: UpdateHouseRequest): Promise<UpdateHouseResponse> {
    const { id, ...changes } = parseRequest(UpdateHouseRequestSchema, request);
    return { house: toHouseMessage(await this.houses.update(id, changes)) };
  }

  async deleteHouse(request: DeleteHouseRequest): Promise<DeleteHouseResponse> {
    const { id } = parseRequest(DeleteHouseRequestSchema, request);
    await this.houses.delete(id);
    return {};
  }
}
