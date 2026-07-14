import { create, fromJson, toJson } from '@bufbuild/protobuf';
import { createValidator } from '@bufbuild/protovalidate';
import { describe, expect, it } from 'vitest';
import { MaterialSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';

describe('Pages-compatible generated runtime', () => {
  it('shares ESM descriptors, ProtoJSON, and validation with the Pages function graph', async () => {
    const pagesModule = await import('../../functions/api/[[path]]');
    const message = create(MaterialSchema, {
      name: 'materials/cup',
      uid: '00000000-0000-4000-8000-000000000003',
      displayName: 'Cup',
      size: '10cm',
      weight: '250g',
    });
    const decoded = fromJson(MaterialSchema, toJson(MaterialSchema, message));
    const validation = createValidator().validate(MaterialSchema, decoded);

    expect(pagesModule.onRequest).toBeTypeOf('function');
    expect(decoded).toEqual(message);
    expect(validation.kind).toBe('valid');
  });
});
