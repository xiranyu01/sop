import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { Lifecycle, RevisionOrigin } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { exportRequirementYaml, exportTaskSopYaml } from '../../server/export';
import { convertLegacyToV1alpha1 } from '../../server/bootstrap/legacyToV1alpha1';
import { seedData } from '../e2e/fixtures/seed';

async function golden(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), 'tests/fixtures/yaml', name), 'utf8');
}

function markRequirementConfirmed(snapshot: ReturnType<typeof convertLegacyToV1alpha1>['resources']): void {
  const revision = snapshot.requirementRevisions[0];
  revision.snapshot!.lifecycle = Lifecycle.CONFIRMED;
  revision.origin = RevisionOrigin.IMPORTED_CONFIRMED;
  revision.exportEligible = true;
}

describe('deterministic canonical YAML export', () => {
  it('matches the reviewed TaskSop golden and remains byte-identical after current catalog edits', async () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).resources;
    const first = exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1');
    snapshot.scenes = snapshot.scenes.map((scene) => ({ ...scene, displayName: '后续修改的当前场景' }));
    snapshot.globalFields = snapshot.globalFields.map((field) => ({ ...field, value: '后续修改的当前词表' }));
    const second = exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1');
    expect(first).toBe(await golden('task-sop.golden.yaml'));
    expect(second).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
    expect(YAML.parse(first)).toEqual(expect.objectContaining({
      format: 'coscene.sop.export',
      schema_version: '2.0.0',
      task_sop: expect.objectContaining({ status: '已确认' }),
    }));
  });

  it('matches the reviewed Requirement golden and omits history, storage, and volatile metadata', async () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).resources;
    markRequirementConfirmed(snapshot);
    const output = exportRequirementYaml(snapshot, 'REQ001', '0.0.1');
    expect(output).toBe(await golden('requirement.golden.yaml'));
    expect(output).not.toMatch(/root:|storage_key|etag|current_revision|previous_revision|create_time|update_time|export_time/);
    const document = YAML.parse(output);
    expect(document).toEqual(expect.objectContaining({
      format: 'coscene.sop.export',
      schema_version: '2.0.0', requirement: expect.objectContaining({ basic_info: expect.any(Object) }),
    }));
  });

  it('never rewrites enum-looking free text', () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).resources;
    markRequirementConfirmed(snapshot);
    snapshot.requirementRevisions[0].snapshot!.spec!.businessGoal = 'PRIORITY_P1';
    const output = exportRequirementYaml(snapshot, 'REQ001', '0.0.1');
    expect(output).toContain('business_goal: PRIORITY_P1');
    expect(output).not.toContain('priority:');
  });

  it('omits internal or unused fields from the domain YAML', () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).resources;
    snapshot.taskSopRevisions[0].snapshot!.spec!.expectedDuration = {
      $typeName: 'google.protobuf.Duration', seconds: 3661n, nanos: 500_000_000,
    };
    const output = exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1');
    expect(output).not.toMatch(/expected_duration|step_order|open_questions|change_interval_records|value_source/);
  });

  it('uses material name consistently in Task SOP and Requirement YAML', () => {
    const data = structuredClone(seedData);
    data.scenes[0].subscenes[0].versions[0].materials = [{
      materialId: data.materials[0].id,
      skuId: data.materials[0].skuId,
      type: data.materials[0].type,
      quantity: { mode: 'fixed', value: 1, unit: '件' },
      color: data.materials[0].color,
      material: data.materials[0].material,
      packageType: data.materials[0].packageType,
    }];
    data.requirements[0].versions[0].selectedSubscenes = [{
      id: 'production-item-1',
      title: data.scenes[0].subscenes[0].name,
      sceneName: data.scenes[0].name,
      subsceneName: data.scenes[0].subscenes[0].name,
      version: '0.0.1',
      targetDurationHours: 1,
      targetCollectionCount: 1,
    }];
    const snapshot = convertLegacyToV1alpha1(data).resources;
    markRequirementConfirmed(snapshot);

    const taskMaterial = YAML.parse(exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1'))
      .task_sop.environment_config.materials[0];
    const requirementMaterial = YAML.parse(exportRequirementYaml(snapshot, 'REQ001', '0.0.1'))
      .requirement.task_sop_details[0].environment_config.materials[0];

    expect(taskMaterial).toEqual(expect.objectContaining({ name: '测试物料' }));
    expect(taskMaterial).not.toHaveProperty('type');
    expect(requirementMaterial).toEqual(expect.objectContaining({ name: '测试物料' }));
    expect(requirementMaterial).not.toHaveProperty('type');
  });

  it('exports public attachment URLs only and never performs provider checks', () => {
    const data = structuredClone(seedData);
    data.scenes[0].subscenes[0].versions[0].attachments = [{
      id: 'utf8-file', name: '测试 附件.txt', size: 4, contentType: 'text/plain', storageKey: 'managed/file',
      uploadedAt: '2026-01-01T00:00:00.000Z',
    }];
    const snapshot = convertLegacyToV1alpha1(data).resources;
    const attachment = snapshot.taskSopRevisions[0].frozenDependencies!.attachments[0];
    attachment.uri = 'https://cdn.example.test/%7E/%2F?q=a%2Fb#%E7%89%87%E6%AE%B5';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const output = exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1');
    expect(output).toContain('https://cdn.example.test/%7E/%2F?q=a%2Fb#%E7%89%87%E6%AE%B5');
    expect(output).not.toContain('测试 附件.txt');
    expect(output).not.toContain('managed/file');
    expect(output).not.toContain('sha256:');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    attachment.uri = undefined;
    attachment.sizeBytes = undefined;
    const withoutOptionalMetadata = exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1');
    expect(withoutOptionalMetadata).not.toContain('public_uri:');
    expect(withoutOptionalMetadata).not.toContain('https://cdn.example.test');
    attachment.uri = 'http://cdn.example.test/file';
    expect(exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1')).toContain('http://cdn.example.test/file');
  });
});
