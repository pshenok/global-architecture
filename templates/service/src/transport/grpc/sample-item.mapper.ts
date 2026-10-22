import type { SampleItem as SampleItemMessage } from '@ga/contracts/ga/sample_item/v1/sample_item';
import type { SampleItem } from '../../domain/sample-item.ts';

/** Domain -> wire. The only place that knows both shapes. */
export function toSampleItemMessage(sampleItem: SampleItem): SampleItemMessage {
  return {
    id: sampleItem.id,
    name: sampleItem.name,
    description: sampleItem.description,
    createTime: sampleItem.createdAt,
    updateTime: sampleItem.updatedAt,
  };
}
