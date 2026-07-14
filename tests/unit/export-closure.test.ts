import { describe, expect, it } from 'vitest';
import { Lifecycle } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { buildExportBundle } from '../../server/export/bundle';
import { resolveExportClosure } from '../../server/export/closure';
import { convertLegacyToV1alpha1 } from '../../server/migrations/legacyToV1alpha1';
import { seedData } from '../e2e/fixtures/seed';

function requirementSnapshot() {
  const data = structuredClone(seedData);
  data.requirements[0].versions[0].status = 'confirmed';
  data.requirements[0].versions[0].selectedSubscenes = [
    {
      id: 'item-b', title: '第二项', sceneName: '基线场景', subsceneName: '基线任务 SOP',
      subsceneCode: 'NO.001', version: '0.0.1', targetDurationHours: 1, targetCollectionCount: 2,
      taskSop: { sceneName: '基线场景', title: '基线任务 SOP', version: '0.0.1', status: 'confirmed' },
    },
    {
      id: 'item-a', title: '第一项', sceneName: '基线场景', subsceneName: '基线任务 SOP',
      subsceneCode: 'NO.001', version: '0.0.1', targetDurationHours: 2, targetCollectionCount: 3,
      taskSop: { sceneName: '基线场景', title: '基线任务 SOP', version: '0.0.1', status: 'confirmed' },
    },
  ];
  return convertLegacyToV1alpha1(data).snapshot;
}

describe('canonical export closure', () => {
  it('resolves exact immutable Requirement dependencies and deduplicates TaskSop revisions', () => {
    const closure = resolveExportClosure(requirementSnapshot(), {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    });
    expect(closure.requirements).toHaveLength(1);
    expect(closure.taskSops).toHaveLength(1);
    expect(closure.robotModelRevisions).toHaveLength(1);
    expect(closure.customers).toHaveLength(1);
    const bundle = buildExportBundle(closure);
    expect(bundle.requirements[0].spec?.productionItems.map((item) => item.displayName)).toEqual(['第二项', '第一项']);
    expect(bundle.requirements[0].spec?.productionItems[0].taskSopRef).toBe(bundle.taskSops[0].ref);
  });

  it('exports a standalone TaskSop without inventing Requirement or Robot dependencies', () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).snapshot;
    const closure = resolveExportClosure(snapshot, {
      kind: 'task_sop', sourceId: 'scene-baseline-NO.001', versionLabel: '0.0.1',
    });
    expect(closure.taskSops).toHaveLength(1);
    expect(closure.requirements).toEqual([]);
    expect(closure.robotModelRevisions).toEqual([]);
    expect(closure.customers).toEqual([]);
  });

  it('fails closed for draft roots, draft dependencies, and missing pinned revisions', () => {
    const draft = convertLegacyToV1alpha1(structuredClone(seedData)).snapshot;
    expect(() => resolveExportClosure(draft, {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    })).toThrow('仅支持导出已确认版本');

    const snapshot = requirementSnapshot();
    snapshot.taskSopRevisions[0].snapshot!.lifecycle = Lifecycle.DRAFT;
    expect(() => resolveExportClosure(snapshot, {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    })).toThrow('仅支持导出已确认版本');

    const missing = requirementSnapshot();
    missing.robotModelRevisions = [];
    expect(() => resolveExportClosure(missing, {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    })).toThrow('缺少机器人版本');
  });

  it('does not let one TaskSop frozen closure compensate for another missing dependency', () => {
    const snapshot = requirementSnapshot();
    const second = structuredClone(snapshot.taskSopRevisions[0]);
    second.name = 'taskSops/missing-scene/revisions/v-0-0-1';
    second.snapshot!.name = 'taskSops/missing-scene';
    second.snapshot!.sourceId = 'missing-scene';
    second.frozenDependencies!.scenes = [];
    snapshot.taskSopRevisions.push(second);
    snapshot.requirementRevisions[0].snapshot!.spec!.productionItems[1].taskSopRevision = second.name;

    expect(() => resolveExportClosure(snapshot, {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    })).toThrow('导出闭包缺少场景');
  });

  it('rejects duplicate pinned TaskSop and RobotModel revision names', () => {
    const duplicateTask = requirementSnapshot();
    const task = structuredClone(duplicateTask.taskSopRevisions[0]);
    task.snapshot!.displayName = 'conflicting duplicate';
    duplicateTask.taskSopRevisions.push(task);
    expect(() => resolveExportClosure(duplicateTask, {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    })).toThrow('任务 SOP 版本资源名不唯一');

    const duplicateRobot = requirementSnapshot();
    duplicateRobot.robotModelRevisions.push(structuredClone(duplicateRobot.robotModelRevisions[0]));
    expect(() => resolveExportClosure(duplicateRobot, {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    })).toThrow('机器人版本资源名不唯一');
  });
});
