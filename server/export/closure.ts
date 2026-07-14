import { Lifecycle, RevisionOrigin } from '../../gen/coscene/sop/v1alpha1/common_pb';
import type {
  Attachment,
  Customer,
  GlobalField,
  Material,
  MaterialStateRule,
  RobotModelRevision,
  Scene,
} from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import type { RequirementRevision } from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import type { TaskSopRevision } from '../../gen/coscene/sop/v1alpha1/task_sop_pb';
import { CanonicalDataError } from '../domain/errors';
import { compareStable, stableHash, stableJson } from '../domain/identity';

export type ExportRoot =
  | { kind: 'requirement'; sourceId: string; versionLabel: string }
  | { kind: 'task_sop'; sourceId: string; versionLabel: string };

export type ExportClosure = {
  root: ExportRoot;
  rootRef: string;
  requirements: RequirementRevision[];
  taskSops: TaskSopRevision[];
  robotModelRevisions: RobotModelRevision[];
  customers: Customer[];
  materials: Material[];
  scenes: Scene[];
  globalFields: GlobalField[];
  materialStateRules: MaterialStateRule[];
  attachments: Attachment[];
};

/**
 * Candidate records used to resolve one root's frozen export closure. Runtime
 * callers supply only the selected root and its direct/pinned dependencies;
 * the bootstrap converter may supply its deterministic repository records.
 */
export type ExportClosureSource = {
  requirementRevisions: RequirementRevision[];
  taskSopRevisions: TaskSopRevision[];
  robotModelRevisions: RobotModelRevision[];
};

export function bundleRef(kind: string, sourceName: string): string {
  return `${kind}-${stableHash(sourceName).slice(0, 12)}`;
}

function sourceId(value: { name: string; sourceId?: string }): string {
  return value.sourceId || value.name.split('/').at(-1) || value.name;
}

function frozenSemantic<T extends { name: string }>(value: T): string {
  const copy = structuredClone(value) as T & Record<string, unknown>;
  delete copy.createTime;
  delete copy.updateTime;
  delete copy.etag;
  delete copy.currentRevision;
  delete copy.storageKey;
  return stableJson(copy);
}

function addFrozen<T extends { name: string }>(target: Map<string, T>, values: T[], owner: string): void {
  for (const value of values) {
    const valueUid = (value as T & { uid?: string }).uid;
    const uidOwner = valueUid ? [...target.values()].find((candidate) =>
      (candidate as T & { uid?: string }).uid === valueUid && candidate.name !== value.name) : undefined;
    if (uidOwner) throw new CanonicalDataError(`导出闭包中 UID 对应多个资源名：${valueUid}`);
    const previous = target.get(value.name);
    if (previous && frozenSemantic(previous) !== frozenSemantic(value)) {
      throw new CanonicalDataError(`导出闭包中存在冲突的冻结资源：${value.name}（${owner}）`);
    }
    target.set(value.name, value);
  }
}

function requireConfirmed(
  revision: RequirementRevision | TaskSopRevision,
): void {
  if (!revision.snapshot || revision.snapshot.lifecycle !== Lifecycle.CONFIRMED) {
    throw new CanonicalDataError(`仅支持导出已确认版本：${revision.name}`);
  }
  if (!revision.exportEligible || ![
    RevisionOrigin.RUNTIME_CONFIRMED,
    RevisionOrigin.IMPORTED_CONFIRMED,
  ].includes(revision.origin)) {
    throw new CanonicalDataError(`版本不是可导出的已确认历史：${revision.name}`);
  }
  if (!revision.frozenDependencies) {
    throw new CanonicalDataError(`已确认版本缺少冻结依赖：${revision.name}`);
  }
}

function requireByName<T extends { name: string }>(values: T[], name: string, kind: string): T {
  const value = values.find((candidate) => candidate.name === name);
  if (!value) throw new CanonicalDataError(`导出闭包缺少${kind}：${name}`);
  return value;
}

function sortByName<T extends { name: string }>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) => compareStable(left.name, right.name));
}

function uniqueIndex<T extends { name: string }>(values: T[], kind: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.name)) throw new CanonicalDataError(`${kind}资源名不唯一：${value.name}`);
    result.set(value.name, value);
  }
  return result;
}

function referencedAttachments(task: TaskSopRevision['snapshot']): Set<string> {
  const result = new Set(task?.attachments ?? []);
  const spec = task?.spec;
  for (const object of spec?.objects ?? []) {
    for (const name of object.images) result.add(name);
  }
  for (const state of spec?.objectStates?.initial ?? []) {
    for (const location of state.allowedLocations) for (const name of location.exampleImages) result.add(name);
  }
  for (const state of spec?.objectStates?.target ?? []) {
    for (const name of state.requiredLocation?.exampleImages ?? []) result.add(name);
  }
  for (const rule of spec?.randomization?.objectInitialStates ?? []) {
    for (const name of rule.exampleImages) result.add(name);
  }
  return result;
}

export function resolveExportClosure(sourceRecords: ExportClosureSource, root: ExportRoot): ExportClosure {
  const taskByName = uniqueIndex(sourceRecords.taskSopRevisions, '任务 SOP 版本');
  const robotByName = uniqueIndex(sourceRecords.robotModelRevisions, '机器人版本');
  const requirements = new Map<string, RequirementRevision>();
  const taskSops = new Map<string, TaskSopRevision>();
  const robots = new Map<string, RobotModelRevision>();
  const customers = new Map<string, Customer>();
  const materials = new Map<string, Material>();
  const scenes = new Map<string, Scene>();
  const globalFields = new Map<string, GlobalField>();
  const rules = new Map<string, MaterialStateRule>();
  const attachments = new Map<string, Attachment>();

  const addTask = (revision: TaskSopRevision): void => {
    if (taskSops.has(revision.name)) return;
    requireConfirmed(revision);
    const task = revision.snapshot!;
    const frozen = revision.frozenDependencies!;
    requireByName(frozen.scenes, task.scene, '场景');
    for (const object of task.spec?.objects ?? []) {
      if (object.material) requireByName(frozen.materials, object.material, '物料');
    }
    for (const rule of task.spec?.materialStateRules ?? []) {
      const frozenRule = requireByName(frozen.materialStateRules, rule.name, '物料状态规则');
      if (frozenSemantic(rule) !== frozenSemantic(frozenRule)) {
        throw new CanonicalDataError(`任务 SOP 内嵌规则与冻结规则不一致：${rule.name}`);
      }
    }
    for (const name of referencedAttachments(task)) requireByName(frozen.attachments, name, '附件');
    for (const material of frozen.materials) {
      for (const name of material.images) requireByName(frozen.attachments, name, '物料附件');
    }
    taskSops.set(revision.name, revision);
    addFrozen(materials, frozen.materials, revision.name);
    addFrozen(scenes, frozen.scenes, revision.name);
    addFrozen(globalFields, frozen.globalFields, revision.name);
    addFrozen(rules, frozen.materialStateRules, revision.name);
    addFrozen(attachments, frozen.attachments, revision.name);
  };

  let rootRef: string;
  if (root.kind === 'requirement') {
    const candidates = sourceRecords.requirementRevisions.filter((value) =>
      sourceId(value.snapshot ?? { name: '' }) === root.sourceId && value.versionLabel === root.versionLabel);
    if (candidates.length > 1) throw new CanonicalDataError(`客户需求版本定位不唯一：${root.sourceId} v${root.versionLabel}`);
    const revision = candidates[0];
    if (!revision) throw new CanonicalDataError(`找不到客户需求版本：${root.sourceId} v${root.versionLabel}`);
    requireConfirmed(revision);
    requirements.set(revision.name, revision);
    rootRef = bundleRef('requirement', revision.name);
    const requirement = revision.snapshot!;
    const frozen = revision.frozenDependencies!;
    addFrozen(customers, frozen.customers, revision.name);
    addFrozen(globalFields, frozen.globalFields, revision.name);
    addFrozen(attachments, frozen.attachments, revision.name);
    requireByName([...customers.values()], requirement.spec!.customer, '客户');
    for (const name of requirement.attachments) requireByName([...attachments.values()], name, '附件');
    const robot = robotByName.get(requirement.spec!.robotModelRevision);
    if (!robot?.snapshot) throw new CanonicalDataError(`导出闭包缺少机器人版本：${requirement.spec!.robotModelRevision}`);
    robots.set(robot.name, robot);
    for (const item of requirement.spec!.productionItems) {
      if (!item.taskSopRevision) throw new CanonicalDataError(`生产需求项未固定任务 SOP 版本：${item.id}`);
      addTask(requireByName([...taskByName.values()], item.taskSopRevision, '任务 SOP 版本'));
    }
  } else {
    const candidates = sourceRecords.taskSopRevisions.filter((value) =>
      sourceId(value.snapshot ?? { name: '' }) === root.sourceId && value.versionLabel === root.versionLabel);
    if (candidates.length > 1) throw new CanonicalDataError(`任务 SOP 版本定位不唯一：${root.sourceId} v${root.versionLabel}`);
    const revision = candidates[0];
    if (!revision) throw new CanonicalDataError(`找不到任务 SOP 版本：${root.sourceId} v${root.versionLabel}`);
    addTask(revision);
    rootRef = bundleRef('task-sop', revision.name);
  }

  return {
    root,
    rootRef,
    requirements: sortByName(requirements.values()),
    taskSops: sortByName(taskSops.values()),
    robotModelRevisions: sortByName(robots.values()),
    customers: sortByName(customers.values()),
    materials: sortByName(materials.values()),
    scenes: sortByName(scenes.values()),
    globalFields: sortByName(globalFields.values()),
    materialStateRules: sortByName(rules.values()),
    attachments: sortByName(attachments.values()),
  };
}
