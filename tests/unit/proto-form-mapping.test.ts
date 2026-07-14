import { describe, expect, it } from 'vitest';
import { fromDomainJson } from '../../shared/domain/codec';
import { MaterialSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { decodeMaterialForm, encodeMaterialForm } from '../../src/domain/protoFormMapping';

describe('Proto resource form mapping', () => {
  it('round-trips one Material without changing its identity, etag, or attachment references', () => {
    const detail = {
      name: 'materials/cup',
      uid: '11111111-1111-4111-8111-111111111111',
      displayName: 'Cup',
      sku: 'SKU001',
      category: 'Cup',
      colors: ['red', 'blue'],
      compositions: ['ceramic', 'glass'],
      packaging: 'box',
      images: ['attachments/front'],
      etag: 'etag-1',
      size: '10cm',
      sourceId: 'material-1',
    };
    const decoded = decodeMaterialForm(detail);
    const encoded = encodeMaterialForm({ ...decoded.value, color: 'green', weight: '200g' }, decoded.message);
    const message = fromDomainJson(MaterialSchema, encoded);

    expect(message).toMatchObject({
      name: detail.name,
      uid: detail.uid,
      etag: detail.etag,
      sourceId: detail.sourceId,
      colors: ['green'],
      compositions: ['ceramic'],
      images: ['attachments/front'],
      weight: '200g',
    });
  });
});
