import { describe, expect, it } from 'vitest';
import { fromDomainJson } from '../../shared/domain/codec';
import { GlobalFieldSchema, MaterialSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { GlobalFieldGroup, GlobalFieldStatus } from '../../gen/coscene/sop/v1alpha1/common_pb';
import {
  decodeGlobalFieldForm,
  decodeMaterialForm,
  encodeGlobalFieldForm,
  encodeMaterialForm,
} from '../../src/domain/protoFormMapping';

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

  it('round-trips atomic skill start and end conditions', () => {
    const detail = {
      name: 'globalFields/pickup',
      uid: '22222222-2222-4222-8222-222222222222',
      group: 'GLOBAL_FIELD_GROUP_ATOMIC_SKILL',
      label: '拿起',
      value: '拿起',
      startCondition: '夹爪开始闭合',
      endCondition: '物体稳定离开支撑面',
      status: 'GLOBAL_FIELD_STATUS_ACTIVE',
      etag: 'etag-atomic-skill',
    };
    const decoded = decodeGlobalFieldForm(detail);
    expect(decoded.value).toMatchObject({
      group: 'atomic_skill',
      startCondition: detail.startCondition,
      endCondition: detail.endCondition,
    });

    const encoded = fromDomainJson(GlobalFieldSchema, encodeGlobalFieldForm({
      ...decoded.value,
      endCondition: '物体被稳定抓持',
    }, decoded.message));
    expect(encoded).toMatchObject({
      group: GlobalFieldGroup.ATOMIC_SKILL,
      status: GlobalFieldStatus.ACTIVE,
      startCondition: detail.startCondition,
      endCondition: '物体被稳定抓持',
    });
  });
});
