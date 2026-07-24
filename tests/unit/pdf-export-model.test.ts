import { describe, expect, it } from 'vitest';
import { Lifecycle, RevisionOrigin } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { buildExportBundle } from '../../server/export/bundle';
import { resolveExportClosure } from '../../server/export/closure';
import { convertLegacyToV1alpha1 } from '../../server/bootstrap/legacyToV1alpha1';
import { renderFrozenPdfModel } from '../../src/export/pdf';
import { seedData } from '../e2e/fixtures/seed';

function completeData() {
  const data = structuredClone(seedData);
  const image = {
    id: 'pdf-example-image', name: '洗漱台示例.png', size: 1024, contentType: 'image/png',
    storageKey: 'fixtures/pdf-example-image.png', uploadedAt: '2026-01-01T00:00:00.000Z',
  };
  data.materials[0].images = [image];
  data.globalFields.push(
    { id: 'robot-position', group: 'robot_random_field', label: '位置', value: 'initial_position', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'material-location', group: 'material_random_field', label: '物料位置', value: 'location', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' },
  );
  const version = data.scenes[0].subscenes[0].versions[0];
  version.attachments = [image];
  version.materials = [{
    materialId: 'mat-baseline', skuId: 'SKU001', type: '测试物料',
    quantity: { mode: 'fixed', value: 2, unit: '件' }, color: '白色', material: '塑料', packageType: '盒装',
  }];
  const location = {
    location: '洗漱台台面',
    referencePath: [{ level: 1, referenceObject: '洗手盆', relativePosition: '右侧' }],
    supportSurface: '底面', allowedRegions: ['右侧'], allowedPose: ['平放'], allowedForm: ['完整'],
    parameters: ['干燥'], collectorInstruction: '放在采集员容易看清的位置',
    exampleImageAttachmentIds: [image.id], constraints: ['不要放入水槽'],
  };
  version.objectStates = {
    initial: [{ object: '测试物料', allowedLocations: [location] }],
    target: [{
      object: '测试物料', requiredLocation: '洗漱台台面', requiredRegions: ['左侧'], requiredPose: ['平放'],
      requiredForm: ['完整'], referencePath: location.referencePath, supportSurface: '底面', parameters: ['干燥'],
      collectorInstruction: '整理完成后保持可见', exampleImageAttachmentIds: [image.id], constraints: ['摆放整齐'],
    }],
  };
  version.randomization.robotInitialState = {
    enabled: true, changeFrequency: 'every_n_records', changeIntervalRecords: 3,
    randomizedFields: [{ field: 'initial_position', displayName: '位置', constraints: ['保持物料可见'] }],
  };
  version.randomization.materialInitialState.rules = [{
    targetMaterials: ['测试物料'], changeFrequency: 'every_n_records', changeIntervalRecords: 5,
    randomizedFields: { locations: [{ name: 'location', valueSource: '物料初始状态' }], poses: [], forms: [] },
    collectorInstruction: '每 5 条换一个位置', exampleImageAttachmentIds: [image.id],
    constraints: [
      '每次采集前需要改变位置',
      '仍需满足 object_states.initial 中定义的允许状态',
      '保持在台面上',
    ],
  }];
  version.operation.steps = [{
    order: 1, description: '拿起测试物料', atomicSkill: '拿起',
    englishDescription: 'Pick up the material', englishAtomicSkill: 'Pick',
  }];
  version.operation.stepRandomization = { enabled: true, startOrder: 1, endOrder: 1 };
  version.operation.allowedOperations = [{ description: '夹持物料主体' }];
  version.operation.acceptableOperations = [{ description: '轻微调整后完成' }];
  version.operation.forbiddenOperations = [{ description: '碰撞洗手盆' }];
  version.annotation.steps = [{
    order: 1, description: '标注拿起动作', atomicSkill: '拿起',
    englishDescription: 'Annotate pick action', englishAtomicSkill: 'Pick',
  }];
  version.annotation.allowedOperations = [{ description: '拿起：开始时机为夹爪开始闭合；结束时机为物体稳定离开支撑面' }];
  version.annotation.forbiddenOperations = [{ description: '不要跨动作合并标注' }];
  return data;
}

function taskBundle() {
  const snapshot = convertLegacyToV1alpha1(completeData()).resources;
  snapshot.attachments[0].uri = 'https://example.test/fixtures/pdf-example-image.png';
  return {
    snapshot,
    bundle: buildExportBundle(resolveExportClosure(snapshot, {
      kind: 'task_sop', sourceId: 'scene-baseline-NO.001', versionLabel: '0.0.1',
    })),
  };
}

function requirementBundle() {
  const data = completeData();
  data.requirements[0].versions[0].selectedSubscenes = [{
    sceneName: '基线场景', subsceneCode: 'NO.001', subsceneName: '基线任务 SOP',
    targetDurationHours: 0, targetCollectionCount: 10,
    taskSop: { sceneName: '基线场景', title: '基线任务 SOP', version: '0.0.1', status: 'confirmed' },
  }];
  data.requirements[0].versions[0].attachments = [{
    id: 'requirement-file', name: '客户原始需求.pdf', size: 2048, contentType: 'application/pdf',
    storageKey: 'fixtures/requirement-file.pdf', uploadedAt: '2026-01-01T00:00:00.000Z',
  }];
  data.requirements[0].versions[0].allowedOperations = [{ operation: '保持画面稳定', note: '' }];
  const snapshot = convertLegacyToV1alpha1(data).resources;
  for (const attachment of snapshot.attachments) attachment.uri = `https://example.test/${attachment.storageKey}`;
  const revision = snapshot.requirementRevisions[0];
  revision.snapshot!.lifecycle = Lifecycle.CONFIRMED;
  revision.origin = RevisionOrigin.IMPORTED_CONFIRMED;
  revision.exportEligible = true;
  return buildExportBundle(resolveExportClosure(snapshot, {
    kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
  }));
}

describe('versioned frozen PDF view', () => {
  it('renders every customer-facing Task SOP section without internal identities', () => {
    const { snapshot, bundle } = taskBundle();
    const first = renderFrozenPdfModel(bundle.content!);
    snapshot.scenes[0].displayName = '后来修改的场景';
    snapshot.taskSops[0].displayName = '后来修改的任务';
    const second = renderFrozenPdfModel(bundle.content!);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      rendererVersion: 'sop-pdf-v1', title: '基线任务 SOP',
      fileName: '基线任务 SOP-v0.0.1.pdf', trace: [],
    });
    expect(first.sections.map((item) => item.id)).toEqual([
      'basic', 'attachments', 'robot', 'materials', 'material-images', 'initial-states', 'target-states',
      'material-randomization', 'collection-steps', 'collection-allowed', 'collection-forbidden',
      'collection-acceptable', 'annotation-steps', 'annotation-allowed', 'annotation-forbidden',
    ]);
    expect(first.sections.find((item) => item.id === 'materials')?.tables?.[0]).toMatchObject({
      columns: expect.arrayContaining(['SKU', '物料名称', '数量']),
      rows: [expect.arrayContaining(['SKU001', '测试物料', '2 件'])],
    });
    expect(first.sections.find((item) => item.id === 'collection-steps')?.tables?.[0]).toMatchObject({
      columns: ['序号', '中文步骤', '中文原子技能', 'English Step', 'English Atomic Skill'],
      rows: [['1', '拿起测试物料', '拿起', 'Pick up the material', 'Pick']],
    });
    expect(first.sections.find((item) => item.id === 'initial-states')?.items?.[0]).toContain(
      '把 测试物料，放在 洗手盆的右侧，接触 底面，区域为 右侧，姿态为 平放，形态为 完整，参数为 干燥。',
    );
    expect(first.sections.find((item) => item.id === 'initial-states')?.items?.[0]).not.toContain('放在/靠近什么');
    expect(first.sections.find((item) => item.id === 'attachments')?.attachments?.[0]).toMatchObject({
      name: '洗漱台示例.png', url: 'https://example.test/fixtures/pdf-example-image.png',
    });
    expect(first.sections.find((item) => item.id === 'material-randomization')?.tables?.[0].rows[0].at(-1))
      .toBe('保持在台面上');
    expect(JSON.stringify(first)).not.toContain('object_states.initial');
    expect(JSON.stringify(first)).not.toContain('每次采集前需要改变位置');
    expect(JSON.stringify(first)).not.toContain('scene-baseline-NO.001');
  });

  it('renders Requirement production and delivery sections from pinned content', () => {
    const model = renderFrozenPdfModel(requirementBundle().content!);
    expect(model).toMatchObject({ title: '基线客户需求', fileName: '基线客户需求-v0.0.1.pdf', trace: [] });
    expect(model.sections.map((item) => item.id)).toEqual([
      'basic', 'attachments', 'delivery', 'global', 'global-collection-allowed',
      'global-collection-acceptable', 'global-collection-forbidden', 'global-annotation-allowed',
      'global-annotation-forbidden', 'production-items', 'task-1-basic', 'task-1-attachments',
      'task-1-robot', 'task-1-materials', 'task-1-material-images', 'task-1-initial-states',
      'task-1-target-states', 'task-1-material-randomization', 'task-1-collection-steps',
      'task-1-collection-allowed', 'task-1-collection-forbidden', 'task-1-collection-acceptable',
      'task-1-annotation-steps', 'task-1-annotation-allowed', 'task-1-annotation-forbidden',
    ]);
    expect(model.sections.find((item) => item.id === 'production-items')?.tables?.[0]).toMatchObject({
      columns: expect.arrayContaining(['生产需求项', '任务 SOP', '版本', '目标采集数量']),
      rows: [expect.arrayContaining(['基线任务 SOP', '0.0.1', '10'])],
    });
    expect(model.sections.find((item) => item.id === 'attachments')?.attachments?.[0]).toMatchObject({
      name: '客户原始需求.pdf', url: 'https://example.test/fixtures/requirement-file.pdf',
    });
    expect(model.sections.some((item) => item.id === 'task-1-annotation-steps')).toBe(true);
    expect(JSON.stringify(model)).not.toContain('revisions/');
  });

  it('rejects a renderer version without silently using the latest implementation', () => {
    const content = taskBundle().bundle.content!;
    content.rendererVersion = 'sop-pdf-v2';
    expect(() => renderFrozenPdfModel(content)).toThrow('Unsupported PDF renderer version: sop-pdf-v2');
  });
});
