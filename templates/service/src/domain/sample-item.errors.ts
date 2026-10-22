import { ConflictError, NotFoundError } from '@ga/kernel';

export const sampleItemNotFound = (id: string) =>
  new NotFoundError('SAMPLE_ITEM_NOT_FOUND', `sample item ${id} not found`, { sampleItemId: id });

export const sampleItemNameTaken = (name: string) =>
  new ConflictError('SAMPLE_ITEM_NAME_TAKEN', `a sample item named "${name}" already exists`, {
    name,
  });
