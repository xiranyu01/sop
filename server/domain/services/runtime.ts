import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  RobotModelRevisionSchema,
  RobotModelSchema,
} from '../../../gen/coscene/sop/v1alpha1/catalog_pb';
import { Lifecycle } from '../../../gen/coscene/sop/v1alpha1/common_pb';
import { RequirementRevisionSchema } from '../../../gen/coscene/sop/v1alpha1/requirement_pb';
import { TaskSopRevisionSchema } from '../../../gen/coscene/sop/v1alpha1/task_sop_pb';
import type {
  AppData,
  Customer,
  GlobalField,
  Material,
  MaterialStateRule,
  Requirement,
  RobotModel,
  Scene,
} from '../../../src/types';
import type { LegacyApiStore } from '../../../shared/transport/restDto';
import { convertLegacyToV1alpha1 } from '../../migrations/legacyToV1alpha1';
import { canonicalId, deterministicUid, revisionName, stableJson } from '../../migrations/identity';
import { createId, nextPatchVersion } from '../../versioning';
import type { AppStore, AttachmentUploadState, CanonicalSnapshot, StorePin } from '../appStore';
import { runAttachmentCleanup } from '../attachmentCleanup';
import { findReachableManagedAttachment } from '../attachmentReachability';
import type { AttachmentObjectStore } from '../attachmentObjectStore';
import {
  abandonAttachmentUpload,
  assertAttachmentUploadsComplete,
  bindAttachmentUpload,
  finishAttachmentUpload,
  prepareAttachmentCompletion,
  reconcileAttachmentOperations,
  recordAttachmentObjectMetadata,
  recordAttachmentPart,
  recordUnboundAttachmentAbort,
  requireAttachmentUpload,
  type NewAttachmentUpload,
} from '../attachmentService';
import { AtomicCommitError, CanonicalDataError, StaleStoreEpochError } from '../errors';
import { projectCanonicalToRest } from './projection';

export type CanonicalRuntimeOptions = {
  namespace?: string;
  attachments?: Partial<AttachmentObjectStore>;
  writeExport?: LegacyApiStore['writeExport'];
  requestPin?: StorePin;
  clock?: () => Date;
  attachmentRetentionMs?: number;
  attachmentUploadTtlMs?: number;
};

type CanonicalLegacyApiStore = LegacyApiStore & {
  readonly canonical: true;
  beginRequest(): Promise<CanonicalLegacyApiStore>;
  saveRobotModel(model: Partial<RobotModel>): Promise<RobotModel[]>;
  bindAttachmentUpload(input: NewAttachmentUpload): Promise<void>;
  attachmentUpload(input: Pick<AttachmentUploadState, 'uploadId' | 'scope' | 'ownerId' | 'version'> & { attachmentId?: string; allowExpired?: boolean }): Promise<AttachmentUploadState>;
  recordAttachmentPart(uploadId: string, part: AttachmentUploadState['parts'][number]): Promise<void>;
  recordAttachmentObjectMetadata(uploadId: string, sha256?: string): Promise<void>;
  recordUnboundAttachmentAbort(input: { storageKey: string; uploadId: string }): Promise<void>;
  prepareAttachmentCompletion(uploadId: string): Promise<AttachmentUploadState>;
  abandonAttachmentUpload(uploadId: string): Promise<void>;
  writeMaterialsAndFinishUpload(values: Material[], uploadId: string): Promise<Material[]>;
  writeScenesAndFinishUpload(values: Scene[], uploadId: string): Promise<Scene[]>;
  writeRequirementsAndFinishUpload(values: Requirement[], uploadId: string): Promise<Requirement[]>;
  writeMaterialsForAttachmentDelete(values: Material[]): Promise<Material[]>;
  writeScenesForAttachmentDelete(values: Scene[]): Promise<Scene[]>;
  writeRequirementsForAttachmentDelete(values: Requirement[]): Promise<Requirement[]>;
  cleanupAttachments(maxItems?: number): Promise<{ deleted: number; aborted: number; failed: number }>;
  resolveAttachment(storageKey: string): Promise<CanonicalSnapshot['attachments'][number] | undefined>;
};

function converted(data: AppData): CanonicalSnapshot {
  const result = convertLegacyToV1alpha1(data);
  if (!result.report.ok) {
    const detail = result.report.issues.map((issue) => `${issue.owner}${issue.path ? `.${issue.path}` : ''}: ${issue.message}`).join('; ');
    throw new CanonicalDataError(`Canonical REST conversion failed: ${detail}`);
  }
  return result.snapshot;
}

function immutableValue(value: unknown): string {
  if (!value || typeof value !== 'object') return stableJson(value);
  const copy = structuredClone(value) as Record<string, unknown>;
  delete copy.updateTime;
  delete copy.etag;
  return stableJson(copy);
}

function reconcileById<T extends { id: string }>(current: T[], baseline: T[], desired: T[]): T[] {
  const baselineById = new Map(baseline.map((item) => [item.id, item]));
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  const removed = new Set(baseline.filter((item) => !desiredById.has(item.id)).map((item) => item.id));
  const changed = new Map(desired.filter((item) => {
    const before = baselineById.get(item.id);
    return !before || stableJson(before) !== stableJson(item);
  }).map((item) => [item.id, item]));
  const merged = current.filter((item) => !removed.has(item.id)).map((item) => changed.get(item.id) ?? item);
  const present = new Set(merged.map((item) => item.id));
  for (const item of desired) {
    if (!present.has(item.id) && changed.has(item.id)) merged.push(item);
  }
  return merged;
}

type AttachmentEdge = { owner: string; resource: string; attachments: unknown[] };

function attachmentEdges(data: AppData): AttachmentEdge[] {
  return [
    ...data.materials.map((material) => ({
      owner: `material:${material.id}`,
      resource: `material:${material.id}`,
      attachments: material.images ?? [],
    })),
    ...data.requirements.flatMap((requirement) => requirement.versions.map((version) => ({
      owner: `requirement:${requirement.id}:${version.version}`,
      resource: `requirement:${requirement.id}`,
      attachments: version.attachments ?? [],
    }))),
    ...data.scenes.flatMap((scene) => scene.subscenes.flatMap((subscene) => subscene.versions.map((version) => ({
      owner: `task_sop:${scene.id}:${subscene.code}:${version.version}`,
      resource: `task_sop:${scene.id}:${subscene.code}`,
      attachments: version.attachments ?? [],
    })))),
  ];
}

function assertNoDirectAttachmentMutation(current: AppData, next: AppData): void {
  const currentEdges = attachmentEdges(current);
  const currentByOwner = new Map(currentEdges.map((edge) => [edge.owner, edge]));
  for (const edge of attachmentEdges(next)) {
    const previous = currentByOwner.get(edge.owner);
    if (previous) {
      if (stableJson(previous.attachments) !== stableJson(edge.attachments)) {
        throw new CanonicalDataError('附件只能通过专用上传或删除接口修改');
      }
      continue;
    }
    if (edge.attachments.length > 0 && !currentEdges.some((candidate) =>
      candidate.resource === edge.resource && stableJson(candidate.attachments) === stableJson(edge.attachments))) {
      throw new CanonicalDataError('新版本只能继承同一资源已有的附件');
    }
  }
}

function sourceVersionId(revision: { sourceVersionId?: string; name: string }): string {
  return revision.sourceVersionId || revision.name.split('/').at(-1) || revision.name;
}

function mergeAttachments(current: CanonicalSnapshot, candidate: CanonicalSnapshot): CanonicalSnapshot['attachments'] {
  const existingBySource = new Map(current.attachments.map((item) => [item.sourceId || item.name, item]));
  return candidate.attachments.map((item) => {
    const existing = existingBySource.get(item.sourceId || item.name);
    return existing ? {
      ...item,
      uid: existing.uid || item.uid,
      name: existing.name || item.name,
      uri: existing.uri || item.uri,
      sha256: existing.sha256 || item.sha256,
    } : item;
  });
}

function preserveTaskCanonicalOnly(
  base: CanonicalSnapshot['taskSopRevisions'][number] | undefined,
  next: CanonicalSnapshot['taskSopRevisions'][number],
): CanonicalSnapshot['taskSopRevisions'][number] {
  const previous = base?.snapshot?.spec;
  const spec = next.snapshot?.spec;
  if (!previous || !spec) return next;

  spec.objects = spec.objects.map((object, index) => {
    const prior = previous.objects.find((item) => item.id === object.id) ?? previous.objects[index];
    if (!prior) return object;
    const materialDescriptor = object.materialDescriptor
      ? { ...object.materialDescriptor }
      : prior.materialDescriptor;
    if (materialDescriptor) {
      if (prior.materialDescriptor?.size !== undefined) materialDescriptor.size = prior.materialDescriptor.size;
      else delete materialDescriptor.size;
      if (prior.materialDescriptor?.weight !== undefined) materialDescriptor.weight = prior.materialDescriptor.weight;
      else delete materialDescriptor.weight;
    }
    return {
      ...object,
      roles: prior.roles,
      attributes: prior.attributes,
      images: prior.images,
      materialDescriptor,
    };
  });

  const preserveLocationParameters = <T extends { parameters: Array<{ key: string }> }>(
    location: T,
    prior: T | undefined,
  ): T => ({
    ...location,
    parameters: location.parameters.map((parameter, index) => ({
      ...parameter,
      key: prior?.parameters[index]?.key || parameter.key,
    })),
  });
  if (spec.objectStates && previous.objectStates) {
    spec.objectStates.initial = spec.objectStates.initial.map((state, stateIndex) => ({
      ...state,
      allowedLocations: state.allowedLocations.map((location, locationIndex) => preserveLocationParameters(
        location,
        previous.objectStates?.initial[stateIndex]?.allowedLocations[locationIndex],
      )),
    }));
    spec.objectStates.target = spec.objectStates.target.map((state, stateIndex) => ({
      ...state,
      requiredLocation: state.requiredLocation
        ? preserveLocationParameters(state.requiredLocation, previous.objectStates?.target[stateIndex]?.requiredLocation)
        : state.requiredLocation,
    }));
  }

  const preserveRules = <T extends { id: string; note?: string }>(items: T[], prior: T[] | undefined): T[] =>
    items.map((item, index) => ({
      ...item,
      id: prior?.[index]?.id || item.id,
      note: prior?.[index]?.note,
    }));
  if (spec.collection && previous.collection) {
    spec.collection.steps = spec.collection.steps.map((step, index) => ({
      ...step,
      id: previous.collection?.steps[index]?.id || step.id,
    }));
    if (spec.collection.policy && previous.collection.policy) {
      spec.collection.policy.allowed = preserveRules(spec.collection.policy.allowed, previous.collection.policy.allowed);
      spec.collection.policy.acceptable = preserveRules(spec.collection.policy.acceptable, previous.collection.policy.acceptable);
      spec.collection.policy.forbidden = preserveRules(spec.collection.policy.forbidden, previous.collection.policy.forbidden);
    }
  }
  if (spec.annotation && previous.annotation) {
    spec.annotation.steps = spec.annotation.steps.map((step, index) => ({
      ...step,
      id: previous.annotation?.steps[index]?.id || step.id,
    }));
    if (spec.annotation.policy && previous.annotation.policy) {
      spec.annotation.policy.allowed = preserveRules(spec.annotation.policy.allowed, previous.annotation.policy.allowed);
      spec.annotation.policy.acceptable = preserveRules(spec.annotation.policy.acceptable, previous.annotation.policy.acceptable);
      spec.annotation.policy.forbidden = preserveRules(spec.annotation.policy.forbidden, previous.annotation.policy.forbidden);
    }
  }
  return next;
}

function mergeTaskSops(current: CanonicalSnapshot, candidate: CanonicalSnapshot): Pick<CanonicalSnapshot, 'scenes' | 'taskSops' | 'taskSopRevisions' | 'attachments'> {
  const candidateNames = new Set(candidate.taskSopRevisions.map((item) => item.name));
  const referenced = new Set([
    ...current.requirements.flatMap((item) => item.spec?.productionItems.map((production) => production.taskSopRevision) ?? []),
    ...current.requirementRevisions.flatMap((item) => item.snapshot?.spec?.productionItems.map((production) => production.taskSopRevision) ?? []),
  ]);
  for (const existing of current.taskSopRevisions) {
    if (candidateNames.has(existing.name)) continue;
    if (existing.snapshot?.lifecycle !== Lifecycle.DRAFT) throw new CanonicalDataError('只能删除草稿版本');
    if (referenced.has(existing.name)) throw new CanonicalDataError(`任务 SOP 版本仍被客户需求引用：${sourceVersionId(existing)}`);
  }

  const byName = new Map(current.taskSopRevisions.map((item) => [item.name, item]));
  const taskSopRevisions = candidate.taskSopRevisions.map((candidateRevision) => {
    const previous = byName.get(candidateRevision.name);
    const base = previous
      ?? current.taskSopRevisions.find((item) =>
        item.snapshot?.name === candidateRevision.snapshot?.name && item.versionLabel === candidateRevision.versionLabel)
      ?? (candidateRevision.previousRevision ? byName.get(candidateRevision.previousRevision) : undefined);
    const next = preserveTaskCanonicalOnly(base, candidateRevision);
    if (previous?.snapshot?.lifecycle !== undefined && previous.snapshot.lifecycle !== Lifecycle.DRAFT) {
      if (immutableValue(previous.snapshot) !== immutableValue(next.snapshot)) {
        throw new CanonicalDataError(`已确认任务 SOP 版本不可修改：${sourceVersionId(previous)}`);
      }
      return previous;
    }
    if (next.snapshot?.lifecycle === Lifecycle.CONFIRMED) {
      assertAttachmentUploadsComplete(current, {
        scope: 'task_sop', ownerId: next.snapshot.sourceId || next.snapshot.name, version: candidateRevision.versionLabel,
      });
      const state = next.snapshot.spec?.robotState;
      if (!state?.initial.trim() || !state.target.trim()) {
        throw new CanonicalDataError('机器人初始状态和目标状态不能为空，不能确认任务 SOP');
      }
      const missingMaterial = next.snapshot.spec?.objects.find((object) => !object.material || !candidate.materials.some((item) => item.name === object.material));
      if (missingMaterial) throw new CanonicalDataError(`任务物料不存在，不能确认任务 SOP：${missingMaterial.displayName}`);
      return create(TaskSopRevisionSchema, next);
    }
    return next;
  });
  const taskSops = candidate.taskSops.map((item) => taskSopRevisions.find((revision) => revision.name === item.currentRevision)?.snapshot ?? item);
  const sceneBySource = new Map(current.scenes.map((item) => [item.sourceId || item.name, item]));
  const scenes = candidate.scenes.map((item) => {
    const existing = sceneBySource.get(item.sourceId || item.name);
    return existing ? { ...item, uid: existing.uid, name: existing.name, createTime: existing.createTime, updateTime: existing.updateTime, etag: existing.etag } : item;
  });
  return { scenes, taskSops, taskSopRevisions, attachments: mergeAttachments(current, candidate) };
}

function mergeRequirements(current: CanonicalSnapshot, candidate: CanonicalSnapshot): Pick<CanonicalSnapshot, 'requirements' | 'requirementRevisions' | 'attachments'> {
  const candidateNames = new Set(candidate.requirementRevisions.map((item) => item.name));
  for (const existing of current.requirementRevisions) {
    if (candidateNames.has(existing.name)) continue;
    if (existing.snapshot?.lifecycle !== Lifecycle.DRAFT) throw new CanonicalDataError('只能删除草稿版本');
  }
  const byName = new Map(current.requirementRevisions.map((item) => [item.name, item]));
  const taskByName = new Map(candidate.taskSopRevisions.map((item) => [item.name, item]));
  const robotByName = new Map(candidate.robotModelRevisions.map((item) => [item.name, item]));
  const requirementRevisions = candidate.requirementRevisions.map((next) => {
    const previous = byName.get(next.name);
    const base = previous
      ?? current.requirementRevisions.find((item) =>
        item.snapshot?.name === next.snapshot?.name && item.versionLabel === next.versionLabel)
      ?? (next.previousRevision ? byName.get(next.previousRevision) : undefined);
    if (base?.snapshot?.spec?.globalRequirements && next.snapshot?.spec?.globalRequirements) {
      next.snapshot.spec.globalRequirements.topics = base.snapshot.spec.globalRequirements.topics;
    }
    if (previous?.snapshot?.lifecycle !== undefined && previous.snapshot.lifecycle !== Lifecycle.DRAFT) {
      if (immutableValue(previous.snapshot) !== immutableValue(next.snapshot)) {
        throw new CanonicalDataError(`已确认客户需求版本不可修改：${sourceVersionId(previous)}`);
      }
      return previous;
    }
    if (next.snapshot?.lifecycle === Lifecycle.CONFIRMED) {
      assertAttachmentUploadsComplete(current, {
        scope: 'requirement', ownerId: next.snapshot.sourceId || next.snapshot.name, version: next.versionLabel,
      });
      const spec = next.snapshot.spec;
      if (!spec?.customer || !candidate.customers.some((item) => item.name === spec.customer)) {
        throw new CanonicalDataError('客户不存在，不能确认需求');
      }
      if (!spec?.robotModelRevision || !robotByName.has(spec.robotModelRevision)) {
        throw new CanonicalDataError('机器人型号版本不存在，不能确认需求');
      }
      const missing = (spec.productionItems ?? []).filter((item) => {
        const task = taskByName.get(item.taskSopRevision);
        return !task || task.snapshot?.lifecycle !== Lifecycle.CONFIRMED;
      });
      if (missing.length) throw new CanonicalDataError('有任务 SOP 还没有确认，不能确认需求');
      return create(RequirementRevisionSchema, next);
    }
    return next;
  });
  const requirements = candidate.requirements.map((item) => requirementRevisions.find((revision) => revision.name === item.currentRevision)?.snapshot ?? item);
  return { requirements, requirementRevisions, attachments: mergeAttachments(current, candidate) };
}

function nextRobotVersion(current?: string): string {
  return current ? nextPatchVersion(current) : '1.0.0';
}

export class CanonicalRuntime {
  private requestPin?: StorePin;
  private requestBaseline?: AppData;

  constructor(readonly store: AppStore, readonly options: CanonicalRuntimeOptions = {}) {
    this.requestPin = options.requestPin;
  }

  async pin(): Promise<StorePin> {
    return this.requestPin ? { ...this.requestPin } : this.store.pin(this.options.namespace);
  }

  async read(): Promise<{ pin: StorePin; snapshot: CanonicalSnapshot; data: AppData }> {
    const pin = await this.pin();
    const snapshot = await this.store.readSnapshot(pin);
    const data = projectCanonicalToRest(snapshot);
    this.requestBaseline = structuredClone(data);
    return { pin, snapshot, data };
  }

  async mutate(mutator: (snapshot: CanonicalSnapshot, data: AppData) => CanonicalSnapshot): Promise<AppData> {
    let pin = await this.pin();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this.store.commit(pin, (snapshot) => reconcileAttachmentOperations(
          snapshot,
          mutator(snapshot, projectCanonicalToRest(snapshot)),
          this.options.clock?.() ?? new Date(),
          this.options.attachmentRetentionMs ?? 24 * 60 * 60_000,
        ));
        if (this.requestPin) this.requestPin = result.pin;
        const data = projectCanonicalToRest(result.snapshot);
        this.requestBaseline = structuredClone(data);
        return data;
      } catch (error) {
        if (!(error instanceof AtomicCommitError) || attempt === 2) throw error;
        const latest = await this.store.pin(pin.namespace);
        if (latest.epoch !== pin.epoch) throw new StaleStoreEpochError(pin.namespace, pin.epoch, latest.epoch);
        if (latest.generation === pin.generation) throw error;
        pin = latest;
        if (this.requestPin) this.requestPin = latest;
      }
    }
    throw new AtomicCommitError(`Canonical mutation retry exhausted for ${pin.namespace}`);
  }

  async replaceCatalog<K extends 'customers' | 'materials' | 'globalFields' | 'materialStateRules'>(
    key: K,
    values: AppData[K],
    finishUploadId?: string,
    allowAttachmentDelete = false,
  ): Promise<AppData[K]> {
    let baseline = this.requestBaseline?.[key] as AppData[K] | undefined;
    const data = await this.mutate((current, legacy) => {
      baseline ??= structuredClone(legacy[key]) as AppData[K];
      const intended = reconcileById(
        legacy[key] as Array<{ id: string }>,
        baseline as Array<{ id: string }>,
        values as Array<{ id: string }>,
      ) as AppData[K];
      if (key === 'materials' && !finishUploadId && !allowAttachmentDelete) {
        assertNoDirectAttachmentMutation(legacy, { ...legacy, materials: intended as Material[] });
      }
      const candidate = converted({ ...legacy, [key]: intended });
      if (finishUploadId) {
        const upload = current.operational.uploads.find((item) => item.uploadId === finishUploadId);
        const attachment = candidate.attachments.find((item) => item.sourceId === upload?.attachmentId);
        if (attachment && upload?.publicUri) attachment.uri = upload.publicUri;
        if (attachment && upload?.sha256) attachment.sha256 = upload.sha256;
      }
      if (key === 'customers') {
        const retained = new Set(candidate.customers.map((item) => item.name));
        const referenced = new Set([
          ...current.requirements.flatMap((item) => item.spec?.customer ? [item.spec.customer] : []),
          ...current.requirementRevisions.flatMap((item) => item.snapshot?.spec?.customer ? [item.snapshot.spec.customer] : []),
        ]);
        const blocked = current.customers.find((item) => !retained.has(item.name) && referenced.has(item.name));
        if (blocked) throw new CanonicalDataError(`客户仍被客户需求引用：${blocked.displayName}`);
      }
      if (key === 'materials') {
        const retained = new Set(candidate.materials.map((item) => item.name));
        const referenced = new Set([
          ...current.taskSops.flatMap((item) => item.spec?.objects.flatMap((object) => object.material ? [object.material] : []) ?? []),
          ...current.taskSopRevisions.flatMap((item) => item.snapshot?.spec?.objects.flatMap((object) => object.material ? [object.material] : []) ?? []),
        ]);
        const blocked = current.materials.find((item) => !retained.has(item.name) && referenced.has(item.name));
        if (blocked) throw new CanonicalDataError(`物料仍被任务 SOP 引用：${blocked.displayName}`);
      }
      let resources = candidate[key];
      if (key === 'customers') {
        const existing = new Map(current.customers.map((item) => [item.sourceId || item.name, item]));
        resources = candidate.customers.map((item) => {
          const previous = existing.get(item.sourceId || item.name);
          return previous ? { ...item, uid: previous.uid, name: previous.name, createTime: previous.createTime, updateTime: previous.updateTime, etag: previous.etag } : item;
        }) as AppData[K] extends never ? never : typeof candidate[K];
      }
      if (key === 'materials') {
        const existing = new Map(current.materials.map((item) => [item.sourceId || item.name, item]));
        resources = candidate.materials.map((item) => {
          const previous = existing.get(item.sourceId || item.name);
          if (!previous) return item;
          return {
            ...item,
            uid: previous.uid,
            name: previous.name,
            createTime: previous.createTime,
            updateTime: previous.updateTime,
            etag: previous.etag,
            colors: item.colors.length ? [item.colors[0], ...previous.colors.slice(1)] : [],
            compositions: item.compositions.length ? [item.compositions[0], ...previous.compositions.slice(1)] : [],
          };
        }) as typeof candidate[K];
      }
      const next = {
        ...current,
        [key]: resources,
        ...(key === 'materials' ? { attachments: mergeAttachments(current, candidate) } : {}),
      };
      if (finishUploadId) finishAttachmentUpload(next, finishUploadId);
      return next;
    });
    return data[key];
  }

  async saveRobotModel(input: Partial<RobotModel>): Promise<RobotModel[]> {
    const data = await this.mutate((current, legacy) => {
      const id = input.id || createId('robot');
      const models = legacy.robotModels.some((item) => item.id === id)
        ? legacy.robotModels.map((item) => item.id === id ? { ...item, ...input, id } as RobotModel : item)
        : [...legacy.robotModels, { ...input, id } as RobotModel];
      const candidate = converted({ ...legacy, robotModels: models });
      const candidateModel = candidate.robotModels.find((item) => item.sourceId === id);
      if (!candidateModel) throw new CanonicalDataError(`机器人型号转换失败：${id}`);
      const existing = current.robotModels.find((item) => item.sourceId === id);
      const existingRevision = existing?.currentRevision
        ? current.robotModelRevisions.find((item) => item.name === existing.currentRevision)
        : undefined;
      const versionLabel = nextRobotVersion(existingRevision?.versionLabel);
      const sourceRevisionId = createId('robotv');
      const name = revisionName(candidateModel.name, versionLabel, sourceRevisionId);
      const robot = create(RobotModelSchema, {
        ...candidateModel,
        uid: existing?.uid || candidateModel.uid || deterministicUid('robotModel', id),
        name: existing?.name || candidateModel.name,
        sourceId: id,
        topics: candidateModel.topics.map((topic) => {
          const previous = existing?.topics.find((item) => item.id === topic.id);
          return previous ? { ...topic, frequencyHz: previous.frequencyHz, constraints: previous.constraints } : topic;
        }),
        currentRevision: name,
        createTime: existing?.createTime ?? timestampFromDate(new Date()),
        updateTime: timestampFromDate(new Date()),
      });
      const revision = create(RobotModelRevisionSchema, {
        name,
        snapshot: robot,
        previousRevision: existingRevision?.name,
        versionLabel,
        sourceVersionId: sourceRevisionId,
        createTime: timestampFromDate(new Date()),
      });
      return {
        ...current,
        robotModels: existing
          ? current.robotModels.map((item) => item.name === existing.name ? robot : item)
          : [...current.robotModels, robot],
        robotModelRevisions: [...current.robotModelRevisions, revision],
      };
    });
    return data.robotModels;
  }

  async replaceScenes(values: Scene[], finishUploadId?: string, allowAttachmentDelete = false): Promise<Scene[]> {
    let baseline = this.requestBaseline?.scenes;
    const data = await this.mutate((current, legacy) => {
      baseline ??= structuredClone(legacy.scenes);
      const intended = reconcileById(legacy.scenes, baseline, values);
      if (!finishUploadId && !allowAttachmentDelete) assertNoDirectAttachmentMutation(legacy, { ...legacy, scenes: intended });
      const candidate = converted({ ...legacy, scenes: intended });
      if (finishUploadId) {
        const upload = current.operational.uploads.find((item) => item.uploadId === finishUploadId);
        const attachment = candidate.attachments.find((item) => item.sourceId === upload?.attachmentId);
        if (attachment && upload?.publicUri) attachment.uri = upload.publicUri;
        if (attachment && upload?.sha256) attachment.sha256 = upload.sha256;
      }
      const merged = mergeTaskSops(current, candidate);
      const next = { ...current, ...merged };
      if (finishUploadId) finishAttachmentUpload(next, finishUploadId);
      return next;
    });
    return data.scenes;
  }

  async replaceRequirements(values: Requirement[], finishUploadId?: string, allowAttachmentDelete = false): Promise<Requirement[]> {
    let baseline = this.requestBaseline?.requirements;
    const data = await this.mutate((current, legacy) => {
      baseline ??= structuredClone(legacy.requirements);
      const intended = reconcileById(legacy.requirements, baseline, values);
      if (!finishUploadId && !allowAttachmentDelete) assertNoDirectAttachmentMutation(legacy, { ...legacy, requirements: intended });
      const candidate = converted({ ...legacy, requirements: intended });
      if (finishUploadId) {
        const upload = current.operational.uploads.find((item) => item.uploadId === finishUploadId);
        const attachment = candidate.attachments.find((item) => item.sourceId === upload?.attachmentId);
        if (attachment && upload?.publicUri) attachment.uri = upload.publicUri;
        if (attachment && upload?.sha256) attachment.sha256 = upload.sha256;
      }
      // Preserve an existing exact pin when the selected source robot is unchanged;
      // otherwise pin the selected robot's current immutable revision. Candidate
      // `/current` revisions belong only to the conversion boundary.
      for (const next of candidate.requirementRevisions) {
        const nextSpec = next.snapshot?.spec;
        if (!nextSpec) continue;
        const previous = current.requirementRevisions.find((item) => item.name === next.name);
        const newRobot = candidate.robotModelRevisions.find((item) => item.name === nextSpec.robotModelRevision)?.snapshot?.sourceId;
        if (!newRobot) {
          nextSpec.robotModelRevision = '';
          continue;
        }
        const oldRobot = previous?.snapshot?.spec
          ? current.robotModelRevisions.find((item) => item.name === previous.snapshot!.spec!.robotModelRevision)?.snapshot?.sourceId
          : undefined;
        if (previous?.snapshot?.spec && oldRobot === newRobot) {
          nextSpec.robotModelRevision = previous.snapshot.spec.robotModelRevision;
        } else {
          const selected = current.robotModels.find((item) => item.sourceId === newRobot);
          if (!selected?.currentRevision) throw new CanonicalDataError('机器人型号当前版本不存在');
          nextSpec.robotModelRevision = selected.currentRevision;
        }
      }
      candidate.robotModelRevisions = current.robotModelRevisions;
      const merged = mergeRequirements(current, candidate);
      const next = { ...current, ...merged };
      if (finishUploadId) finishAttachmentUpload(next, finishUploadId);
      return next;
    });
    return data.requirements;
  }

  async bindAttachmentUpload(input: NewAttachmentUpload): Promise<void> {
    await this.mutate((current) => {
      const next = structuredClone(current);
      bindAttachmentUpload(next, input, this.options.clock?.() ?? new Date(), this.options.attachmentUploadTtlMs ?? 24 * 60 * 60_000);
      return next;
    });
  }

  async attachmentUpload(input: Pick<AttachmentUploadState, 'uploadId' | 'scope' | 'ownerId' | 'version'> & { attachmentId?: string; allowExpired?: boolean }): Promise<AttachmentUploadState> {
    const pin = await this.pin();
    return requireAttachmentUpload(
      await this.store.readSnapshot(pin),
      input,
      input.allowExpired ? undefined : (this.options.clock?.() ?? new Date()),
    );
  }

  async recordAttachmentPart(uploadId: string, part: AttachmentUploadState['parts'][number]): Promise<void> {
    await this.mutate((current) => {
      const next = structuredClone(current); recordAttachmentPart(next, uploadId, part); return next;
    });
  }

  async recordAttachmentObjectMetadata(uploadId: string, sha256?: string): Promise<void> {
    await this.mutate((current) => {
      const next = structuredClone(current); recordAttachmentObjectMetadata(next, uploadId, sha256); return next;
    });
  }

  async recordUnboundAttachmentAbort(input: { storageKey: string; uploadId: string }): Promise<void> {
    await this.mutate((current) => {
      const next = structuredClone(current);
      recordUnboundAttachmentAbort(next, input, this.options.clock?.() ?? new Date());
      return next;
    });
  }

  async prepareAttachmentCompletion(uploadId: string): Promise<AttachmentUploadState> {
    let upload: AttachmentUploadState | undefined;
    await this.mutate((current) => {
      const next = structuredClone(current);
      upload = prepareAttachmentCompletion(next, uploadId, this.options.clock?.() ?? new Date());
      return next;
    });
    return upload!;
  }

  async abandonAttachmentUpload(uploadId: string): Promise<void> {
    await this.mutate((current) => {
      const next = structuredClone(current); abandonAttachmentUpload(next, uploadId, this.options.clock?.() ?? new Date()); return next;
    });
  }
}

export function createCanonicalApiStore(appStore: AppStore, options: CanonicalRuntimeOptions = {}): CanonicalLegacyApiStore {
  const runtime = new CanonicalRuntime(appStore, options);
  const attachment = options.attachments ?? {};
  const objectStore: Partial<AttachmentObjectStore> = {};
  if (attachment.createAttachmentUpload) objectStore.createAttachmentUpload = (input) => attachment.createAttachmentUpload!(input);
  if (attachment.uploadAttachmentPart) objectStore.uploadAttachmentPart = (input) => attachment.uploadAttachmentPart!(input);
  if (attachment.completeAttachmentUpload) objectStore.completeAttachmentUpload = (input) => attachment.completeAttachmentUpload!(input);
  if (attachment.abortAttachmentUpload) objectStore.abortAttachmentUpload = (input) => attachment.abortAttachmentUpload!(input);
  if (attachment.deleteAttachment) objectStore.deleteAttachment = (storageKey) => attachment.deleteAttachment!(storageKey);
  if (attachment.getAttachment) objectStore.getAttachment = (storageKey) => attachment.getAttachment!(storageKey);
  if (attachment.headAttachment) objectStore.headAttachment = (storageKey) => attachment.headAttachment!(storageKey);
  if (attachment.attachmentExists) objectStore.attachmentExists = (storageKey) => attachment.attachmentExists!(storageKey);
  return {
    canonical: true,
    async beginRequest() {
      const requestPin = await appStore.pin(options.namespace);
      return createCanonicalApiStore(appStore, { ...options, requestPin });
    },
    async readData() { return (await runtime.read()).data; },
    async writeCustomers(values: Customer[]) { return runtime.replaceCatalog('customers', values); },
    async writeMaterials(values: Material[]) { return runtime.replaceCatalog('materials', values); },
    async writeRobotModels(values: RobotModel[]) {
      throw new AtomicCommitError(`Canonical robot saves require saveRobotModel; received ${values.length} models`);
    },
    async saveRobotModel(value) { return runtime.saveRobotModel(value); },
    async bindAttachmentUpload(input) { return runtime.bindAttachmentUpload(input); },
    async attachmentUpload(input) { return runtime.attachmentUpload(input); },
    async recordAttachmentPart(uploadId, part) { return runtime.recordAttachmentPart(uploadId, part); },
    async recordAttachmentObjectMetadata(uploadId, sha256) { return runtime.recordAttachmentObjectMetadata(uploadId, sha256); },
    async recordUnboundAttachmentAbort(input) { return runtime.recordUnboundAttachmentAbort(input); },
    async prepareAttachmentCompletion(uploadId) { return runtime.prepareAttachmentCompletion(uploadId); },
    async abandonAttachmentUpload(uploadId) { return runtime.abandonAttachmentUpload(uploadId); },
    async writeMaterialsAndFinishUpload(values, uploadId) { return runtime.replaceCatalog('materials', values, uploadId); },
    async writeScenesAndFinishUpload(values, uploadId) { return runtime.replaceScenes(values, uploadId); },
    async writeRequirementsAndFinishUpload(values, uploadId) { return runtime.replaceRequirements(values, uploadId); },
    async writeMaterialsForAttachmentDelete(values) { return runtime.replaceCatalog('materials', values, undefined, true); },
    async writeScenesForAttachmentDelete(values) { return runtime.replaceScenes(values, undefined, true); },
    async writeRequirementsForAttachmentDelete(values) { return runtime.replaceRequirements(values, undefined, true); },
    async cleanupAttachments(maxItems) {
      if (!attachment.deleteAttachment || !attachment.abortAttachmentUpload) throw new Error('附件存储未配置');
      return runAttachmentCleanup(appStore, {
        deleteAttachment: attachment.deleteAttachment.bind(attachment),
        abortAttachmentUpload: attachment.abortAttachmentUpload.bind(attachment),
      }, { namespace: options.namespace, clock: options.clock, maxItems });
    },
    async resolveAttachment(storageKey) {
      const pin = await appStore.pin(options.namespace);
      return findReachableManagedAttachment(await appStore.readSnapshot(pin), storageKey);
    },
    async writeScenes(values: Scene[]) { return runtime.replaceScenes(values); },
    async writeRequirements(values: Requirement[]) { return runtime.replaceRequirements(values); },
    async writeGlobalFields(values: GlobalField[]) { return runtime.replaceCatalog('globalFields', values); },
    async writeMaterialStateRules(values: MaterialStateRule[]) { return runtime.replaceCatalog('materialStateRules', values); },
    async writeExport(requirementId, version, yaml) {
      return options.writeExport ? options.writeExport(requirementId, version, yaml) : `/exports/requirements/${canonicalId(requirementId, requirementId)}/${version}.yaml`;
    },
    ...objectStore,
  };
}

export function isCanonicalApiStore(store: LegacyApiStore): store is CanonicalLegacyApiStore {
  return (store as Partial<CanonicalLegacyApiStore>).canonical === true;
}
