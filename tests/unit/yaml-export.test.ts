import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { Lifecycle, RevisionOrigin } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { exportRequirementYaml, exportTaskSopYaml } from '../../server/export';
import { convertLegacyToV1alpha1 } from '../../server/migrations/legacyToV1alpha1';
import { seedData } from '../e2e/fixtures/seed';

async function golden(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), 'tests/fixtures/yaml', name), 'utf8');
}

function expectLocalRefsResolve(document: Record<string, unknown>): void {
  const collections = [
    'requirements', 'task_sops', 'customers', 'robot_model_revisions', 'materials', 'scenes',
    'global_fields', 'material_state_rules', 'attachments',
  ];
  const refs = new Set(collections.flatMap((key) =>
    ((document[key] as Array<{ ref: string }> | undefined) ?? []).map((entry) => entry.ref)));
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'ref' || key.endsWith('_ref')) expect(refs.has(String(item)), `${key}: ${String(item)}`).toBe(true);
      if (key.endsWith('_refs')) for (const ref of item as string[]) expect(refs.has(ref), `${key}: ${ref}`).toBe(true);
      visit(item);
    }
  };
  visit(document.root);
  for (const key of collections) visit(document[key]);
}

function markRequirementConfirmed(snapshot: ReturnType<typeof convertLegacyToV1alpha1>['snapshot']): void {
  const revision = snapshot.requirementRevisions[0];
  revision.snapshot!.lifecycle = Lifecycle.CONFIRMED;
  revision.origin = RevisionOrigin.IMPORTED_CONFIRMED;
  revision.exportEligible = true;
}

describe('deterministic canonical YAML export', () => {
  it('matches the reviewed TaskSop golden and remains byte-identical after current catalog edits', async () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).snapshot;
    const first = exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1');
    snapshot.scenes = snapshot.scenes.map((scene) => ({ ...scene, displayName: '后续修改的当前场景' }));
    snapshot.globalFields = snapshot.globalFields.map((field) => ({ ...field, value: '后续修改的当前词表' }));
    const second = exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1');
    expect(first).toBe(await golden('task-sop.golden.yaml'));
    expect(second).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
    expectLocalRefsResolve(YAML.parse(first));
  });

  it('matches the reviewed Requirement golden and omits history, storage, and volatile metadata', async () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).snapshot;
    markRequirementConfirmed(snapshot);
    const output = exportRequirementYaml(snapshot, 'REQ001', '0.0.1');
    expect(output).toBe(await golden('requirement.golden.yaml'));
    expect(output).not.toMatch(/storage_key|etag|current_revision|previous_revision|create_time|update_time|export_time/);
    const document = YAML.parse(output);
    expect(document).toEqual(expect.objectContaining({
      format: 'coscene.sop.export', schema_version: '1.0.0', root: expect.objectContaining({ kind: 'requirement' }),
    }));
    expectLocalRefsResolve(document);
  });

  it('never rewrites enum-looking free text', () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).snapshot;
    markRequirementConfirmed(snapshot);
    snapshot.requirementRevisions[0].snapshot!.spec!.businessGoal = 'PRIORITY_P1';
    const output = exportRequirementYaml(snapshot, 'REQ001', '0.0.1');
    expect(output).toContain('business_goal: PRIORITY_P1');
    expect(output).toContain('priority: p1');
  });

  it('serializes durations as one canonical ISO 8601 representation', () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).snapshot;
    snapshot.taskSopRevisions[0].snapshot!.spec!.expectedDuration = {
      $typeName: 'google.protobuf.Duration', seconds: 3661n, nanos: 500_000_000,
    };
    const output = exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1');
    expect(output).toContain('expected_duration: PT1H1M1.5S');
  });

  it('preserves optional attachment metadata exactly and never performs provider checks', () => {
    const data = structuredClone(seedData);
    data.scenes[0].subscenes[0].versions[0].attachments = [{
      id: 'utf8-file', name: '测试 附件.txt', size: 4, contentType: 'text/plain', storageKey: 'managed/file',
      uploadedAt: '2026-01-01T00:00:00.000Z',
    }];
    const snapshot = convertLegacyToV1alpha1(data).snapshot;
    const attachment = snapshot.taskSopRevisions[0].frozenDependencies!.attachments[0];
    attachment.uri = 'https://cdn.example.test/%7E/%2F?q=a%2Fb#%E7%89%87%E6%AE%B5';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const output = exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1');
    expect(output).toContain('https://cdn.example.test/%7E/%2F?q=a%2Fb#%E7%89%87%E6%AE%B5');
    expect(output).toContain('测试 附件.txt');
    expect(output).not.toContain('managed/file');
    expect(output).not.toContain('sha256:');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    attachment.sha256 = 'b'.repeat(64);
    expect(exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1')).toContain(`sha256: ${'b'.repeat(64)}`);
    attachment.uri = undefined;
    attachment.sizeBytes = undefined;
    const withoutOptionalMetadata = exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1');
    expect(withoutOptionalMetadata).not.toContain('public_uri:');
    expect(withoutOptionalMetadata).not.toContain('size_bytes:');
    attachment.uri = 'http://cdn.example.test/file';
    expect(exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1')).toContain('http://cdn.example.test/file');
  });
});
