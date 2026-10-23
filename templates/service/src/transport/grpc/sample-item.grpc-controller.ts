import {
  type CreateSampleItemRequest,
  type CreateSampleItemResponse,
  type DeleteSampleItemRequest,
  type DeleteSampleItemResponse,
  type GetSampleItemRequest,
  type GetSampleItemResponse,
  type ListSampleItemsRequest,
  type ListSampleItemsResponse,
  type SampleItemServiceController,
  SampleItemServiceControllerMethods,
  type UpdateSampleItemRequest,
  type UpdateSampleItemResponse,
} from '@ga/contracts/ga/sample_item/v1/sample_item';
import { decodePageToken, encodePageToken, filterFingerprint, resolvePageSize } from '@ga/kernel';
import { Access, currentUser, parseRequest } from '@ga/service-kit';
import { Controller } from '@nestjs/common';
import { SampleItemService } from '../../application/sample-item.service.ts';
import { toSampleItemMessage } from './sample-item.mapper.ts';
import {
  CreateSampleItemRequestSchema,
  DeleteSampleItemRequestSchema,
  GetSampleItemRequestSchema,
  ListSampleItemsRequestSchema,
  UpdateSampleItemRequestSchema,
} from './sample-item.requests.ts';

/**
 * gRPC adapter: validate the request, call one use case with the acting user, map
 * the result. No business logic here. Every method declares who may call it
 * (@Access); the service refuses to start otherwise. Errors thrown below become
 * gRPC statuses in the service kit's GrpcErrorFilter.
 */
@Controller()
@SampleItemServiceControllerMethods()
export class SampleItemGrpcController implements SampleItemServiceController {
  constructor(private readonly sampleItems: SampleItemService) {}

  @Access.user()
  async createSampleItem(request: CreateSampleItemRequest): Promise<CreateSampleItemResponse> {
    const input = parseRequest(CreateSampleItemRequestSchema, request);
    return { sampleItem: toSampleItemMessage(await this.sampleItems.create(currentUser(), input)) };
  }

  @Access.user()
  async getSampleItem(request: GetSampleItemRequest): Promise<GetSampleItemResponse> {
    const { id } = parseRequest(GetSampleItemRequestSchema, request);
    return { sampleItem: toSampleItemMessage(await this.sampleItems.get(currentUser(), id)) };
  }

  @Access.user()
  async listSampleItems(request: ListSampleItemsRequest): Promise<ListSampleItemsResponse> {
    const { pageSize, pageToken } = parseRequest(ListSampleItemsRequestSchema, request);
    const actor = currentUser();
    // Bound to the caller, so a page token cannot be replayed by another user.
    const fingerprint = filterFingerprint({ userId: actor.userId });
    const page = await this.sampleItems.list(actor, {
      limit: resolvePageSize(pageSize),
      after: decodePageToken(pageToken, fingerprint),
    });
    return {
      sampleItems: page.items.map(toSampleItemMessage),
      nextPageToken: page.nextAfter ? encodePageToken(page.nextAfter, fingerprint) : '',
    };
  }

  @Access.user()
  async updateSampleItem(request: UpdateSampleItemRequest): Promise<UpdateSampleItemResponse> {
    const { id, ...changes } = parseRequest(UpdateSampleItemRequestSchema, request);
    return {
      sampleItem: toSampleItemMessage(await this.sampleItems.update(currentUser(), id, changes)),
    };
  }

  @Access.user()
  async deleteSampleItem(request: DeleteSampleItemRequest): Promise<DeleteSampleItemResponse> {
    const { id } = parseRequest(DeleteSampleItemRequestSchema, request);
    await this.sampleItems.delete(currentUser(), id);
    return {};
  }
}
