import { toBinary } from '@bufbuild/protobuf';
import {
  ExportBundleSchema,
  FrozenExportContentSchema,
  type ExportBundle,
  type FrozenExportContent,
} from '../../gen/coscene/sop/export/v1alpha1/bundle_pb';
import { sha256 } from '../../shared/crypto/hash';
import { fromDomainJsonString, toDomainJson } from '../../shared/domain/codec';
import { assertValidDomainMessage } from '../../shared/domain/validation';
import { CanonicalDataError } from '../domain/errors';

export const sealedBundleFormat = 'coscene.sop.export.sealed' as const;
export const frozenExportFormat = 'coscene.sop.export' as const;
export const exportSchemaVersion = '1.0.0' as const;

const encoder = new TextEncoder();

export type FrozenContentMeasurements = {
  contentSha256: string;
  contentSizeBytes: bigint;
};

export function canonicalFrozenContentProtoJson(content: FrozenExportContent): string {
  assertValidDomainMessage(FrozenExportContentSchema, content);
  return JSON.stringify(toDomainJson(FrozenExportContentSchema, content));
}

export function measureFrozenExportContent(content: FrozenExportContent): FrozenContentMeasurements {
  assertValidDomainMessage(FrozenExportContentSchema, content);
  const binary = toBinary(FrozenExportContentSchema, content, { writeUnknownFields: false });
  const canonicalJson = canonicalFrozenContentProtoJson(content);
  return {
    contentSha256: sha256(binary),
    contentSizeBytes: BigInt(encoder.encode(canonicalJson).byteLength),
  };
}

export function verifyExportBundle(bundle: ExportBundle): ExportBundle {
  if (bundle.format !== sealedBundleFormat) {
    throw new CanonicalDataError(`Unsupported sealed bundle format: ${bundle.format || '<missing>'}`);
  }
  if (bundle.schemaVersion !== exportSchemaVersion) {
    throw new CanonicalDataError(`Unsupported sealed bundle schema version: ${bundle.schemaVersion || '<missing>'}`);
  }
  if (!bundle.content) throw new CanonicalDataError('Sealed bundle content is missing');
  if (bundle.content.format !== frozenExportFormat || bundle.content.schemaVersion !== exportSchemaVersion) {
    throw new CanonicalDataError('Sealed bundle content schema does not match its envelope');
  }
  assertValidDomainMessage(ExportBundleSchema, bundle);
  const expected = measureFrozenExportContent(bundle.content);
  if (bundle.contentSha256 !== expected.contentSha256) {
    throw new CanonicalDataError('Sealed bundle content hash mismatch');
  }
  if (bundle.contentSizeBytes !== expected.contentSizeBytes) {
    throw new CanonicalDataError('Sealed bundle content size mismatch');
  }
  return bundle;
}

export function encodeExportBundle(bundle: ExportBundle): string {
  verifyExportBundle(bundle);
  return JSON.stringify(toDomainJson(ExportBundleSchema, bundle));
}

export function decodeExportBundle(value: string): ExportBundle {
  try {
    return verifyExportBundle(fromDomainJsonString(ExportBundleSchema, value));
  } catch (error) {
    if (error instanceof CanonicalDataError) throw error;
    throw new CanonicalDataError('Malformed sealed export bundle', { cause: error });
  }
}
