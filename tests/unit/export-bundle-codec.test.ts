import { describe, expect, it } from 'vitest';
import { buildExportBundle } from '../../server/export/bundle';
import {
  canonicalFrozenContentProtoJson,
  decodeExportBundle,
  encodeExportBundle,
  measureFrozenExportContent,
} from '../../server/export/codec';
import { resolveExportClosure } from '../../server/export/closure';
import { serializeExportBundleYaml } from '../../server/export/yaml';
import { convertLegacyToV1alpha1 } from '../../server/bootstrap/legacyToV1alpha1';
import { seedData } from '../e2e/fixtures/seed';

function taskBundle() {
  const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).resources;
  return buildExportBundle(resolveExportClosure(snapshot, {
    kind: 'task_sop',
    sourceId: 'scene-baseline-NO.001',
    versionLabel: '0.0.1',
  }));
}

describe('sealed export bundle codec', () => {
  it('round-trips the current schema and measures exactly the frozen content scope', () => {
    const bundle = taskBundle();
    const encoded = encodeExportBundle(bundle);
    const decoded = decodeExportBundle(encoded);
    const measured = measureFrozenExportContent(decoded.content!);

    expect(decoded).toEqual(bundle);
    expect(decoded.contentSha256).toBe(measured.contentSha256);
    expect(decoded.contentSizeBytes).toBe(measured.contentSizeBytes);
    expect(decoded.contentSizeBytes).toBe(BigInt(new TextEncoder().encode(
      canonicalFrozenContentProtoJson(decoded.content!),
    ).byteLength));
  });

  it('rejects unknown fields, unknown versions, content tampering, and size tampering', () => {
    const encoded = encodeExportBundle(taskBundle());
    const unknown = JSON.parse(encoded) as Record<string, unknown>;
    unknown.unrecognized = true;
    expect(() => decodeExportBundle(JSON.stringify(unknown))).toThrow('Malformed sealed export bundle');

    const version = JSON.parse(encoded) as { schemaVersion: string };
    version.schemaVersion = '2.0.0';
    expect(() => decodeExportBundle(JSON.stringify(version))).toThrow('Unsupported sealed bundle schema version');

    const content = JSON.parse(encoded) as { content: { rootName: string } };
    content.content.rootName = 'taskSops/tampered';
    expect(() => decodeExportBundle(JSON.stringify(content))).toThrow('content hash mismatch');

    const size = JSON.parse(encoded) as { contentSizeBytes: string };
    size.contentSizeBytes = String(BigInt(size.contentSizeBytes) + 1n);
    expect(() => decodeExportBundle(JSON.stringify(size))).toThrow('content size mismatch');
  });

  it('exports missing optional attachment URL, hash, and size without provider checks', () => {
    const data = structuredClone(seedData);
    data.scenes[0].subscenes[0].versions[0].attachments = [{
      id: 'optional-metadata',
      name: 'optional.txt',
      size: 4,
      contentType: 'text/plain',
      storageKey: 'managed/optional',
      uploadedAt: '2026-01-01T00:00:00.000Z',
    }];
    const snapshot = convertLegacyToV1alpha1(data).resources;
    const attachment = snapshot.taskSopRevisions[0].frozenDependencies!.attachments[0];
    attachment.sizeBytes = undefined;
    attachment.uri = undefined;
    attachment.sha256 = undefined;

    const bundle = buildExportBundle(resolveExportClosure(snapshot, {
      kind: 'task_sop',
      sourceId: 'scene-baseline-NO.001',
      versionLabel: '0.0.1',
    }));
    const yaml = serializeExportBundleYaml(bundle);
    expect(yaml).toContain('filename: optional.txt');
    expect(yaml).not.toContain('public_uri:');
    expect(yaml).not.toContain('sha256:');
    expect(yaml).not.toContain('size_bytes:');
  });
});
