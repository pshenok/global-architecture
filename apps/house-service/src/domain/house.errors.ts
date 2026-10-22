import { NotFoundError, PreconditionFailedError } from '@ga/kernel';

export const houseNotFound = (id: string) =>
  new NotFoundError('HOUSE_NOT_FOUND', `house ${id} not found`, { houseId: id });

export const ownerNotFound = (ownerId: string) =>
  new PreconditionFailedError('HOUSE_OWNER_NOT_FOUND', `owner ${ownerId} does not exist`, {
    ownerId,
  });
