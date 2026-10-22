import type { HouseServiceClient } from '@ga/contracts/ga/house/v1/house';
import { grpcStatusOf, toDependencyError } from '@ga/service-kit';
import { status } from '@grpc/grpc-js';
import { Inject, Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { HouseCatalog } from '../../application/ports/house-catalog.ts';
import type { HouseTerms } from '../../domain/booking.ts';
import { HOUSE_SERVICE } from './house-service.client.ts';

/** HouseCatalog backed by house-service over gRPC (anti-corruption layer: maps its House to our HouseTerms). */
@Injectable()
export class GrpcHouseCatalog extends HouseCatalog {
  constructor(@Inject(HOUSE_SERVICE) private readonly houses: HouseServiceClient) {
    super();
  }

  async findTerms(houseId: string): Promise<HouseTerms | null> {
    try {
      const { house } = await firstValueFrom(this.houses.getHouse({ id: houseId }));
      if (!house?.nightlyPrice) return null;
      return { maxGuests: house.maxGuests, nightlyPrice: { ...house.nightlyPrice } };
    } catch (error) {
      if (grpcStatusOf(error) === status.NOT_FOUND) return null;
      throw toDependencyError(error, 'house-service');
    }
  }
}
