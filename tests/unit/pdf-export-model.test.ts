import { describe, expect, it } from 'vitest';
import { Lifecycle, RevisionOrigin } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { buildExportBundle } from '../../server/export/bundle';
import { resolveExportClosure } from '../../server/export/closure';
import { convertLegacyToV1alpha1 } from '../../server/bootstrap/legacyToV1alpha1';
import { renderFrozenPdfModel } from '../../src/export/pdf';
import { seedData } from '../e2e/fixtures/seed';

function taskBundle() {
  const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).resources;
  return {
    snapshot,
    bundle: buildExportBundle(resolveExportClosure(snapshot, {
      kind: 'task_sop', sourceId: 'scene-baseline-NO.001', versionLabel: '0.0.1',
    })),
  };
}

function requirementBundle() {
  const data = structuredClone(seedData);
  data.requirements[0].versions[0].selectedSubscenes = [{
    sceneName: '基线场景', subsceneCode: 'NO.001', subsceneName: '基线任务 SOP',
    targetDurationHours: 0, targetCollectionCount: 10,
    taskSop: { sceneName: '基线场景', title: '基线任务 SOP', version: '0.0.1', status: 'confirmed' },
  }];
  const snapshot = convertLegacyToV1alpha1(data).resources;
  const revision = snapshot.requirementRevisions[0];
  revision.snapshot!.lifecycle = Lifecycle.CONFIRMED;
  revision.origin = RevisionOrigin.IMPORTED_CONFIRMED;
  revision.exportEligible = true;
  return buildExportBundle(resolveExportClosure(snapshot, {
    kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
  }));
}

describe('versioned frozen PDF view', () => {
  it('renders TaskSop semantics and trace identities deterministically from the bundle', () => {
    const { snapshot, bundle } = taskBundle();
    const first = renderFrozenPdfModel(bundle.content!);
    snapshot.scenes[0].displayName = '后来修改的场景';
    snapshot.taskSops[0].displayName = '后来修改的任务';
    const second = renderFrozenPdfModel(bundle.content!);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      rendererVersion: 'sop-pdf-v1', title: '基线任务 SOP',
      trace: expect.arrayContaining([expect.objectContaining({ label: '版本 UID' })]),
    });
    expect(first.sections.map((item) => item.id)).toEqual(['overview', 'objects', 'steps', 'attachments']);
  });

  it('renders Requirement production and delivery sections from pinned content', () => {
    const model = renderFrozenPdfModel(requirementBundle().content!);
    expect(model.title).toBe('基线客户需求');
    expect(model.sections.map((item) => item.id)).toEqual(['overview', 'production-items', 'delivery', 'attachments']);
    expect(model.sections.find((item) => item.id === 'production-items')?.items).toContain('基线任务 SOP：10 条');
  });

  it('rejects a renderer version without silently using the latest implementation', () => {
    const content = taskBundle().bundle.content!;
    content.rendererVersion = 'sop-pdf-v2';
    expect(() => renderFrozenPdfModel(content)).toThrow('Unsupported PDF renderer version: sop-pdf-v2');
  });
});
