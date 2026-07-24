import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { create } from '@bufbuild/protobuf';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { ChangeFrequency, ChangePolicySchema, Lifecycle, RevisionOrigin } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { ObjectRandomizationSchema, RobotRandomizationSchema } from '../../gen/coscene/sop/v1alpha1/task_sop_pb';
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
      schema_version: '2.0.1',
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
      schema_version: '2.0.1', requirement: expect.objectContaining({ basic_info: expect.any(Object) }),
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
    expect(output).not.toMatch(/expected_duration|step_order|open_questions|value_source/);
  });

  it('exports robot and material change intervals without legacy synthetic constraints', () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).resources;
    const spec = snapshot.taskSopRevisions[0].snapshot!.spec!;
    spec.randomization!.robotInitialState = create(RobotRandomizationSchema, {
      enabled: true,
      change: create(ChangePolicySchema, { frequency: ChangeFrequency.EVERY_N_RECORDS, intervalRecords: 3 }),
      fields: [],
    });
    spec.randomization!.objectInitialStates = [create(ObjectRandomizationSchema, {
      objectIds: ['material-under-test'],
      change: create(ChangePolicySchema, { frequency: ChangeFrequency.EVERY_N_RECORDS, intervalRecords: 50 }),
      fields: [],
      exampleImages: [],
      locations: [],
      poses: [],
      forms: [],
      constraints: [
        '每次采集前需要改变位置',
        '仍需满足 object_states.initial 中定义的允许状态',
        '不要放进水槽',
      ],
    })];

    const document = YAML.parse(exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1'));
    const randomization = document.task_sop.environment_config.randomization;

    expect(randomization.robot_initial_state.change_interval_records).toBe(3);
    expect(randomization.material_initial_state.rules[0]).toEqual(expect.objectContaining({
      change_interval_records: 50,
      constraints: ['不要放进水槽'],
    }));
  });

  it('uses frozen global-field labels for randomization names', () => {
    const data = structuredClone(seedData);
    data.globalFields.push(
      { id: 'robot-position', group: 'robot_random_field', label: '位置', value: 'initial_position', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'robot-yaw', group: 'robot_random_field', label: '机器朝向', value: 'initial_yaw', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'material-location', group: 'material_random_field', label: '物料位置', value: 'location', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' },
    );
    const version = data.scenes[0].subscenes[0].versions[0];
    version.randomization.robotInitialState = {
      enabled: true,
      changeFrequency: 'every_n_records',
      changeIntervalRecords: 1,
      randomizedFields: [
        { field: 'initial_position', displayName: '初始位置', constraints: [] },
        { field: 'initial_yaw', displayName: '初始朝向', constraints: [] },
      ],
    };
    version.randomization.materialInitialState.rules = [{
      targetMaterials: [],
      changeFrequency: 'every_n_records',
      changeIntervalRecords: 1,
      randomizedFields: {
        locations: [{ name: 'location', valueSource: 'object_states.initial.allowed_locations' }],
        poses: [],
        forms: [],
      },
      collectorInstruction: '',
      exampleImageAttachmentIds: [],
      constraints: [],
    }];

    const snapshot = convertLegacyToV1alpha1(data).resources;
    const document = YAML.parse(exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1'));
    const randomization = document.task_sop.environment_config.randomization;

    expect(randomization.robot_initial_state.randomized_fields.map((field: { name: string }) => field.name))
      .toEqual(['位置', '机器朝向']);
    expect(randomization.material_initial_state.rules[0].randomized_fields).toEqual(['物料位置']);
  });

  it('uses the same Chinese fallback labels as the Task SOP detail for legacy random-field IDs', () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).resources;
    const spec = snapshot.taskSopRevisions[0].snapshot!.spec!;
    spec.randomization!.robotInitialState = create(RobotRandomizationSchema, {
      enabled: true,
      change: create(ChangePolicySchema, { frequency: ChangeFrequency.EVERY_N_RECORDS, intervalRecords: 1 }),
      fields: [
        { fieldId: 'initial-position-8ceebaf4', displayName: 'initial-position-8ceebaf4' },
        { fieldId: 'initial-yaw-6150eb28', displayName: 'initial-yaw-6150eb28' },
      ],
    });
    spec.randomization!.objectInitialStates = [create(ObjectRandomizationSchema, {
      objectIds: [],
      change: create(ChangePolicySchema, { frequency: ChangeFrequency.EVERY_N_RECORDS, intervalRecords: 1 }),
      fields: [
        { fieldId: 'location', displayName: 'location' },
        { fieldId: 'pose', displayName: 'pose' },
        { fieldId: 'form', displayName: 'form' },
      ],
      locations: [],
      poses: [],
      forms: [],
    })];

    const document = YAML.parse(exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1'));
    const randomization = document.task_sop.environment_config.randomization;

    expect(randomization.robot_initial_state.randomized_fields.map((field: { name: string }) => field.name))
      .toEqual(['位置', '机器朝向']);
    expect(randomization.material_initial_state.rules[0].randomized_fields)
      .toEqual(['物料位置', '物料姿态', '物料形态']);
  });

  it('rejects unknown machine-only random-field names instead of leaking IDs', () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).resources;
    snapshot.taskSopRevisions[0].snapshot!.spec!.randomization!.robotInitialState = create(RobotRandomizationSchema, {
      enabled: true,
      change: create(ChangePolicySchema, { frequency: ChangeFrequency.EVERY_N_RECORDS, intervalRecords: 1 }),
      fields: [{ fieldId: 'field-deadbeef', displayName: 'field-deadbeef' }],
    });

    expect(() => exportTaskSopYaml(snapshot, 'scene-baseline', 'NO.001', '0.0.1'))
      .toThrow('随机字段缺少可展示的中文名称');
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
