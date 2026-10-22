import type { House as HouseMessage } from '@ga/contracts/ga/house/v1/house';
import type { House } from '../../domain/house.ts';

/** Domain -> wire. */
export function toHouseMessage(house: House): HouseMessage {
  return {
    id: house.id,
    ownerId: house.ownerId,
    title: house.title,
    description: house.description,
    address: { ...house.address },
    nightlyPrice: { ...house.nightlyPrice },
    maxGuests: house.maxGuests,
    createTime: house.createdAt,
    updateTime: house.updatedAt,
  };
}
