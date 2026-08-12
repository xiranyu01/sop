import { describe, expect, it } from 'vitest';
import { Lifecycle } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { buildExportBundle } from '../../server/export/bundle';
import { resolveExportClosure } from '../../server/export/closure';
import { convertLegacyToV1alpha1 } from '../../server/bootstrap/legacyToV1alpha1';
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
  return convertLegacyToV1alpha1(data).resources;
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
    expect(bundle.content?.requirements[0].spec?.productionItems.map((item) => item.displayName)).toEqual(['第二项', '第一项']);
    expect(bundle.content?.requirements[0].spec?.productionItems[0].taskSopRef).toBe(bundle.content?.taskSops[0].ref);
  });

  it('collects one entry per distinct per-item robot revision and dedupes repeats', () => {
    const twoRobots = requirementSnapshot();
    const second = structuredClone(twoRobots.robotModelRevisions[0]);
    second.name = 'robotModels/second-arm/revisions/v-0-0-1';
    second.uid = 'robot-revision-second-arm';
    second.snapshot!.name = 'robotModels/second-arm';
    second.snapshot!.sourceId = 'second-arm';
    second.snapshot!.uid = 'robot-second-arm';
    second.snapshot!.displayName = '第二台机器人';
    twoRobots.robotModelRevisions.push(second);
    const items = twoRobots.requirementRevisions[0].snapshot!.spec!.productionItems;
    items[0].robotModelRevision = second.name;
    items[1].robotModelRevision = second.name;

    const deduped = resolveExportClosure(twoRobots, {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    });
    // Two items pinning the same revision plus the requirement-level default (decision #7).
    expect(deduped.robotModelRevisions.map((item) => item.name)).toEqual([
      twoRobots.robotModelRevisions[0].name,
      second.name,
    ]);

    const distinct = structuredClone(twoRobots);
    distinct.requirementRevisions[0].snapshot!.spec!.productionItems[1].robotModelRevision =
      distinct.robotModelRevisions[0].name;
    expect(resolveExportClosure(distinct, {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    }).robotModelRevisions).toHaveLength(2);
  });

  it('names the offending production item when its pinned robot revision is missing', () => {
    const snapshot = requirementSnapshot();
    const items = snapshot.requirementRevisions[0].snapshot!.spec!.productionItems;
    items[1].robotModelRevision = 'robotModels/ghost-arm/revisions/v-0-0-1';
    expect(() => resolveExportClosure(snapshot, {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    })).toThrow(`导出闭包缺少生产需求项机器人版本：${items[1].id} → robotModels/ghost-arm/revisions/v-0-0-1`);
  });

  it('exports a standalone TaskSop without inventing Requirement or Robot dependencies', () => {
    const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).resources;
    const closure = resolveExportClosure(snapshot, {
      kind: 'task_sop', sourceId: 'scene-baseline-NO.001', versionLabel: '0.0.1',
    });
    expect(closure.taskSops).toHaveLength(1);
    expect(closure.requirements).toEqual([]);
    expect(closure.robotModelRevisions).toEqual([]);
    expect(closure.customers).toEqual([]);
  });

  it('fails closed for draft roots, draft dependencies, and missing pinned revisions', () => {
    const draft = convertLegacyToV1alpha1(structuredClone(seedData)).resources;
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

  it('names the missing requirement default instead of interpolating an empty name', () => {
    // Reachable through the draft/preview export: that path forces the snapshot to
    // CONFIRMED without running Confirm's completeness check, so an unfinished draft
    // arrives here with no default at all. The old message ended in a bare colon.
    const incomplete = requirementSnapshot();
    incomplete.requirementRevisions[0].snapshot!.spec!.robotModelRevision = '';
    expect(() => resolveExportClosure(incomplete, {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    })).toThrow('需求缺少默认机器人型号');
    expect(() => resolveExportClosure(incomplete, {
      kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
    })).not.toThrow(/导出闭包缺少机器人版本：$/);
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
