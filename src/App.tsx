import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { JsonValue } from '@bufbuild/protobuf';
import type {
  AppViewModel,
  Customer,
  EntityStatus,
  GlobalField,
  GlobalFieldGroup,
  GlobalFieldStatus,
  Material,
  MaterialStateRule,
  OperationStep,
  Requirement,
  RequirementAttachment,
  RequirementVersion,
  RobotModel,
  Scene,
  Subscene,
  SubsceneVersion,
  TextItem,
} from './domain/viewModels';
import { createEmptyAppViewModel } from './domain/viewModels';
import type { ExportResult } from '../shared/transport/restDto';
import type { ResourceDetail, ResourceKind, ResourceSummary } from '../shared/transport/resourceDto';
import {
  ApiClient,
  ApiClientError,
  type AttachmentMetadata,
  type AttachmentOwnerResourceKind,
  type AttachmentUploadSession,
} from './api/client';
import {
  findPendingAttachmentCompletion,
  pendingAttachmentCompletionMatchesFile,
  removePendingAttachmentCompletion,
  savePendingAttachmentCompletion,
  type PendingAttachmentCompletion,
} from './api/pendingAttachmentCompletion';
import {
  createCustomerResource,
  createGlobalFieldResource,
  createMaterialResource,
  createRobotModelResource,
  createSceneResource,
  decodeCustomerForm,
  decodeGlobalFieldForm,
  decodeMaterialForm,
  decodeRobotModelForm,
  decodeSceneForm,
  encodeCustomerForm,
  encodeGlobalFieldForm,
  encodeMaterialForm,
  encodeRobotModelForm,
  encodeSceneForm,
} from './domain/protoFormMapping';
import { createApiResourceSaveTransport } from './persistence/apiResourceSaveTransport';
import { DependencyReviewFlow } from './persistence/dependencyReviewFlow';
import { ResourceSaveQueueRegistry } from './persistence/resourceSaveQueueRegistry';
import type { PdfDocumentModel } from './export/pdf';
import {
  createRequirementResource,
  createTaskSopResource,
  decodeRequirementId,
  decodeRequirementVersions,
  decodeTaskSopIdentity,
  decodeTaskSopVersions,
  encodeRequirementVersion,
  encodeTaskSopVersion,
  revisionExportEligible,
  revisionIsCheckpoint,
  revisionNameOf,
} from './domain/versionedProtoFormMapping';
import {
  pageRoutePath,
  parseAppRoute,
  requirementRoutePath,
  taskSopRoutePath,
  type AppPage,
  type AppRoute,
} from './routing';

type Page = AppPage;

const pageStorageKey = 'sop-manager-current-page';
const authStorageKey = 'sop-manager-api-password';

type DataTableColumn<T> = {
  key: string;
  title: string;
  width?: string;
  align?: 'left' | 'center' | 'right';
  allowOverflow?: boolean;
  render: (item: T, index: number) => ReactNode;
};

type CandidateSubsceneOption = {
  sceneId: string;
  sceneName: string;
  code: string;
  name: string;
  versions: SubsceneVersion[];
  selectedVersion: SubsceneVersion;
};

type SubsceneLookupResult = {
  scene: Scene;
  subscene: Subscene;
  version?: SubsceneVersion;
};

type RequirementReturnTarget = {
  requirementId: string;
  version: string;
};

type VersionPatch<T> = Partial<T> & { baseVersion?: string };

type InitialLocationRow = {
  object: string;
  primaryReferences: string[];
  primaryRelativePositions: string[];
  supportSurfaces: string[];
  regions: string[];
  secondaryReferences: string[];
  secondaryRelativePositions: string[];
  poses: string[];
  forms: string[];
  parameters: string[];
  collectorInstruction: string;
  exampleImageAttachmentIds: string[];
  constraints: string[];
};

type TargetStateRow = InitialLocationRow;

type MaterialInitialRandomizationRow = {
  targetMaterials: string[];
  changeIntervalRecords: number;
  randomizedFields: string[];
  collectorInstruction: string;
  exampleImageAttachmentIds: string[];
  constraints: string;
};

type RobotInitialRandomizationRow = {
  target: string;
  changeIntervalRecords: number;
  randomizedFields: string[];
  constraints: string;
};

type Option = {
  value: string;
  label: string;
  category?: string;
  description?: string;
};

type AttachmentStorageStatus = {
  enabled: boolean;
  message: string;
  publicBaseUrl?: string;
};

type PrintableSection = {
  title: string;
  description?: string;
  content: string;
  attachments?: PrintableAttachment[];
};

type PrintableAttachment = {
  name: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  url?: string;
};

type StateImageUploadTarget =
  | { kind: 'initial'; index: number }
  | { kind: 'target'; index: number }
  | { kind: 'randomization'; index: number };

type PrintableReport = {
  title: string;
  subtitle?: string;
  fileName: string;
  sections: PrintableSection[];
};

const globalFieldGroupLabels: Record<GlobalFieldGroup, string> = {
  robot_state: '机器人状态',
  reference_object: '参照物',
  relative_position: '相对位置',
  support_surface: '支撑面',
  region: '区域',
  pose: '姿态',
  form: '形态',
  parameter: '参数',
  allowed_operation: '采集操作要求',
  acceptable_operation: '不完美但可接受的采集操作',
  forbidden_operation: '采集禁止操作',
  annotation_allowed_operation: '标注操作要求',
  annotation_forbidden_operation: '标注禁止操作',
  random_field: '随机字段',
  robot_random_field: '机器人随机性字段',
  material_random_field: '物料随机性字段',
  annotation_type: '标注类型',
  delivery_format: '交付格式',
  delivery_language: '交付语言',
  delivery_method: '交付方式',
  sampling_policy: '质检策略',
};

const hiddenGlobalFieldGroups: GlobalFieldGroup[] = ['random_field'];
const globalFieldGroups = (Object.keys(globalFieldGroupLabels) as GlobalFieldGroup[]).filter(
  (group) => !hiddenGlobalFieldGroups.includes(group),
);

type GlobalFieldCategory = {
  id: string;
  label: string;
  description: string;
  groups: GlobalFieldGroup[];
};

const globalFieldCategoryConfigs: GlobalFieldCategory[] = [
  {
    id: 'object_state',
    label: '对象状态',
    description: '位置、姿态、形态、参数',
    groups: ['reference_object', 'relative_position', 'support_surface', 'region', 'pose', 'form', 'parameter'],
  },
  {
    id: 'randomization',
    label: '随机性',
    description: '机器人与物料随机字段',
    groups: ['robot_random_field', 'material_random_field'],
  },
  {
    id: 'operation',
    label: '采集 / 标注操作',
    description: '操作要求、禁止操作',
    groups: [
      'allowed_operation',
      'acceptable_operation',
      'forbidden_operation',
      'annotation_allowed_operation',
      'annotation_forbidden_operation',
    ],
  },
  {
    id: 'delivery_quality',
    label: '交付 / 质检',
    description: '格式、语言、方式、抽检',
    groups: ['delivery_format', 'delivery_language', 'delivery_method', 'sampling_policy'],
  },
  {
    id: 'base',
    label: '基础字段',
    description: '机器人状态、标注类型',
    groups: ['robot_state', 'annotation_type'],
  },
];

const globalFieldCategories = globalFieldCategoryConfigs
  .map((category) => ({
    ...category,
    groups: category.groups.filter((group) => globalFieldGroups.includes(group)),
  }))
  .filter((category) => category.groups.length > 0);

function findGlobalFieldCategory(group: GlobalFieldGroup) {
  return globalFieldCategories.find((category) => category.groups.includes(group));
}

const defaultAttachmentStorageStatus: AttachmentStorageStatus = { enabled: true, message: '' };

type ResourceBound = {
  __resourceName: string;
  __resourceUid: string;
  __resourceEtag: string;
  __resourceLoaded: boolean;
  __resourceCreatedAt?: string;
  __resourceDraftSyncToken?: number;
  __summaryProductionItemCount?: number;
};

type Bound<T> = T & ResourceBound;

type ResourcePageState = {
  summaries: ResourceSummary[];
  nextCursor?: string;
  loadingMore?: boolean;
  error?: string;
};

function ResourceLoadMoreButton({
  state,
  onLoadMore,
  label,
}: {
  state?: ResourcePageState;
  onLoadMore: () => void;
  label: string;
}) {
  if (!state?.nextCursor && !state?.error) return null;
  return (
    <button className="ghost-button" disabled={state.loadingMore} onClick={onLoadMore}>
      {state.loadingMore ? '正在加载…' : label}
    </button>
  );
}

function bindResource<T extends object>(value: T, summary: ResourceSummary, loaded: boolean): Bound<T> {
  return Object.assign(value, {
    __resourceName: summary.name,
    __resourceUid: summary.uid,
    __resourceEtag: summary.etag,
    __resourceLoaded: loaded,
    __resourceCreatedAt: summary.createdAt,
    __summaryProductionItemCount: summary.productionItemCount,
  });
}

function resourceNameOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const name = (value as Partial<ResourceBound>).__resourceName;
  return typeof name === 'string' && name ? name : undefined;
}

function resourceUidOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const uid = (value as Partial<ResourceBound>).__resourceUid;
  return typeof uid === 'string' && uid ? uid : undefined;
}

function resourceLoaded(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Partial<ResourceBound>).__resourceLoaded);
}

function resourceDraftSyncToken(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const token = (value as Partial<ResourceBound>).__resourceDraftSyncToken;
  return typeof token === 'number' ? token : undefined;
}

/**
 * Reconciles an editor-local draft with an asynchronously updated summary list.
 * Loaded local drafts win unless the matching item is the first loaded detail
 * or carries an explicit queue-action token (reload/reapply/retry).
 */
export function reconcileMasterDraftFromItems<T extends { id: string }>(
  current: T,
  items: T[],
  newDraft: boolean,
  empty: T,
): T {
  if (newDraft) return current;
  const currentName = resourceNameOf(current);
  if (!currentName) return items[0] ?? empty;
  const incoming = items.find((item) => resourceNameOf(item) === currentName);
  if (!incoming) return current;
  const incomingToken = resourceDraftSyncToken(incoming);
  if (incomingToken !== undefined && incomingToken !== resourceDraftSyncToken(current)) return incoming;
  if (!resourceLoaded(current) && resourceLoaded(incoming)) return incoming;
  return current;
}

/** Replaces an already-listed resource without changing its row position. */
export function replaceResourceInPlace<T>(items: T[], value: T): T[] {
  const name = resourceNameOf(value);
  if (!name) return items;
  const index = items.findIndex((item) => resourceNameOf(item) === name);
  if (index < 0) return sortResourcesByCreationTime([...items, value]);
  const next = [...items];
  next[index] = value;
  return sortResourcesByCreationTime(next);
}

function sortResourcesByCreationTime<T>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const leftCreatedAt = (left as Partial<ResourceBound>)?.__resourceCreatedAt || '';
    const rightCreatedAt = (right as Partial<ResourceBound>)?.__resourceCreatedAt || '';
    return compareCreationTime(
      leftCreatedAt,
      rightCreatedAt,
      resourceNameOf(left) || '',
      resourceNameOf(right) || '',
    );
  });
}

function compareCreationTime(
  leftCreatedAt: string | undefined,
  rightCreatedAt: string | undefined,
  leftName: string,
  rightName: string,
): number {
  if (!leftCreatedAt && !rightCreatedAt) return 0;
  if (!leftCreatedAt) return 1;
  if (!rightCreatedAt) return -1;
  const byCreationTime = rightCreatedAt.localeCompare(leftCreatedAt);
  return byCreationTime || leftName.localeCompare(rightName, 'en');
}

function markResourceDraftSync<T extends object>(value: T, token: number): T {
  return Object.assign({}, value, { __resourceDraftSyncToken: token });
}

function resourceTail(name: string): string {
  return name.split('/').at(-1) || name;
}

export function sourceLikeId(summary: ResourceSummary): string {
  return summary.sourceId ?? resourceTail(summary.name);
}

/** Merges summary pages and keeps the creation-time ordering stable. */
export function appendUniqueResourceSummaries(
  current: ResourceSummary[],
  incoming: ResourceSummary[],
): ResourceSummary[] {
  const seen = new Set<string>();
  const unique = [...current, ...incoming].filter((summary) => {
    if (seen.has(summary.name)) return false;
    seen.add(summary.name);
    return true;
  });
  return unique.sort((left, right) => compareCreationTime(left.createdAt, right.createdAt, left.name, right.name));
}

function materialStateRulePlaceholder(summary: ResourceSummary): Bound<MaterialStateRule> {
  return bindResource({
    id: sourceLikeId(summary),
    materialType: summary.displayName,
    primaryReferences: [],
    primaryRelativePositions: [],
    supportSurfaces: [],
    regions: [],
    secondaryReferences: [],
    secondaryRelativePositions: [],
    poses: [],
    forms: [],
    parameters: [],
    updatedAt: new Date(0).toISOString(),
  }, summary, false);
}

export function appendMaterialStateRuleSummaries(
  current: MaterialStateRule[],
  summaries: ResourceSummary[],
): MaterialStateRule[] {
  const names = new Set(current.flatMap((item) => resourceNameOf(item) ?? []));
  const ids = new Set(current.map((item) => item.id));
  const next = [...current];
  for (const summary of summaries) {
    const id = sourceLikeId(summary);
    if (names.has(summary.name) || ids.has(id)) continue;
    names.add(summary.name);
    ids.add(id);
    next.push(materialStateRulePlaceholder(summary));
  }
  return sortResourcesByCreationTime(next);
}

const attachmentResourceNames = new Map<string, string>();
const attachmentForms = new Map<string, RequirementAttachment>();

export function attachmentReferenceNames(resources: JsonValue[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const visit = (value: JsonValue): void => {
    if (typeof value === 'string') {
      if (/^attachments\/[^/]+$/.test(value) && !seen.has(value)) {
        seen.add(value);
        names.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  resources.forEach(visit);
  return names;
}

async function mapWithConcurrency<T, Result>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length || 1));
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export function loadReferencedAttachmentMetadata(
  resources: JsonValue[],
  getMetadata: (uid: string) => Promise<AttachmentMetadata>,
  options: { concurrency?: number; shouldLoad?: (uid: string) => boolean } = {},
): Promise<AttachmentMetadata[]> {
  const uids = attachmentReferenceNames(resources)
    .map(resourceTail)
    .filter((uid) => options.shouldLoad?.(uid) ?? true);
  return mapWithConcurrency(uids, options.concurrency ?? 4, async (uid) => {
    try {
      return await getMetadata(uid);
    } catch (error) {
      const unavailableToOwner = error instanceof ApiClientError && (
        error.status === 404 ||
        (error.status === 400 && error.message.includes('attachment owner does not match'))
      );
      if (!unavailableToOwner) throw error;
      return undefined;
    }
  }).then((results) => results.filter((item): item is AttachmentMetadata => item !== undefined));
}

export function attachmentFormFromMetadata(metadata: AttachmentMetadata): RequirementAttachment {
  return {
    id: metadata.uid,
    name: metadata.filename,
    size: metadata.sizeBytes,
    contentType: metadata.mediaType,
    storageKey: metadata.publicUrl || metadata.objectKey,
    uploadedAt: metadata.uploadedAt || '',
  };
}

function attachmentFormFromName(name: string): RequirementAttachment | undefined {
  const id = resourceTail(name);
  attachmentResourceNames.set(id, name);
  return attachmentForms.get(id);
}

function rememberAttachment(metadata: AttachmentMetadata): RequirementAttachment {
  const name = metadata.name || `attachments/${metadata.uid}`;
  const attachment = attachmentFormFromMetadata(metadata);
  attachmentResourceNames.set(metadata.uid, name);
  attachmentForms.set(metadata.uid, attachment);
  return attachment;
}

const resourceAttachmentResolver = {
  byName: attachmentFormFromName,
  nameById: (id: string) => attachmentResourceNames.get(id),
};

function statusFromLifecycle(lifecycle?: string): EntityStatus {
  if (lifecycle?.endsWith('CONFIRMED')) return 'confirmed';
  if (lifecycle?.endsWith('ARCHIVED')) return 'archived';
  return 'draft';
}

function summaryVersionLabel(summary: ResourceSummary): string {
  return summary.candidateVersionLabel || summary.currentVersionLabel || '0.0.1';
}

function requirementProductionItemCount(requirement: Requirement): number {
  if (resourceLoaded(requirement)) return latest(requirement.versions).selectedSubscenes.length;
  return (requirement as Partial<ResourceBound>).__summaryProductionItemCount ?? 0;
}

function customerPlaceholder(summary: ResourceSummary): Bound<Customer> {
  const customer = summary.listView ? decodeCustomerForm(summary.listView).value : {
    id: sourceLikeId(summary), name: summary.displayName, contact: { name: '', phone: '', email: '' }, notes: '',
  };
  return bindResource(customer, summary, false);
}

function materialPlaceholder(summary: ResourceSummary): Bound<Material> {
  const material = summary.listView ? decodeMaterialForm(summary.listView, resourceAttachmentResolver).value : {
    id: sourceLikeId(summary), skuId: summary.sku || sourceLikeId(summary), type: summary.displayName,
    color: '', material: '', packageType: '', images: [],
  };
  return bindResource(material, summary, false);
}

function robotPlaceholder(summary: ResourceSummary): Bound<RobotModel> {
  const robot = summary.listView ? decodeRobotModelForm(summary.listView).value : {
    id: sourceLikeId(summary), brand: '', model: summary.displayName, terminal: '', topics: {}, extraTopicRequirements: {},
  };
  return bindResource(robot, summary, false);
}

function scenePlaceholder(summary: ResourceSummary): Bound<Scene> {
  return bindResource({ id: sourceLikeId(summary), name: summary.displayName, description: '', subscenes: [] }, summary, false);
}

function globalFieldPlaceholder(summary: ResourceSummary): Bound<GlobalField> {
  if (summary.listView) {
    return bindResource(decodeGlobalFieldForm(summary.listView).value, summary, false);
  }
  const group = summary.fieldGroup?.replace('GLOBAL_FIELD_GROUP_', '').toLowerCase() as GlobalFieldGroup | undefined;
  return bindResource({
    id: sourceLikeId(summary), group: group && globalFieldGroups.includes(group) ? group : 'reference_object',
    label: summary.displayName, value: summary.displayName,
    description: '', status: summary.fieldStatus?.endsWith('INACTIVE') ? 'inactive' : 'active', updatedAt: new Date(0).toISOString(),
  }, summary, false);
}

function requirementPlaceholder(summary: ResourceSummary): Bound<Requirement> {
  const durationSeconds = Number(summary.aggregateDuration?.replace(/s$/, '') ?? 0);
  const version = Object.assign(emptyRequirementVersion(summary.displayName, statusFromLifecycle(summary.lifecycle)), {
    version: summaryVersionLabel(summary),
    customerId: resourceTail(summary.customerName || ''),
    projectName: summary.projectDisplayName || '',
    deadline: summary.deadline || '',
    requiredDurationHours: Number.isFinite(durationSeconds) ? durationSeconds / 3600 : 0,
    __revisionName: summary.currentRevision,
    __revisionExportEligible: Boolean(summary.currentRevision && summary.lifecycle?.endsWith('CONFIRMED')),
    __revisionCheckpoint: false,
  });
  return bindResource({
    id: sourceLikeId(summary),
    versions: [version],
  }, summary, false);
}

function taskPlaceholder(summary: ResourceSummary): Bound<Subscene> {
  const source = sourceLikeId(summary);
  const version = Object.assign(
    {
      ...emptySubsceneVersionDraft(summary.displayName),
      version: summary.candidateVersionLabel || summary.currentVersionLabel || '0.0.1',
      status: statusFromLifecycle(summary.lifecycle),
    } as SubsceneVersion,
    {
      __revisionName: summary.currentRevision,
      __revisionExportEligible: Boolean(summary.currentRevision && summary.lifecycle?.endsWith('CONFIRMED')),
      __revisionCheckpoint: false,
    },
  );
  return bindResource({
    code: source,
    name: summary.displayName,
    versions: [version],
  }, summary, false);
}

export function appendTaskSopSummariesToScenes(scenes: Scene[], summaries: ResourceSummary[]): Scene[] {
  return scenes.map((scene) => {
    const sceneName = resourceNameOf(scene);
    if (!sceneName) return scene;
    const existing = new Set(scene.subscenes.flatMap((item) => resourceNameOf(item) ?? []));
    const additions: Subscene[] = [];
    for (const summary of summaries) {
      if (summary.sceneName !== sceneName || existing.has(summary.name)) continue;
      existing.add(summary.name);
      additions.push(taskPlaceholder(summary));
    }
    return additions.length
      ? { ...scene, subscenes: sortResourcesByCreationTime([...scene.subscenes, ...additions]) }
      : scene;
  });
}

type MasterResourceKind = 'customers' | 'materials' | 'robotModels' | 'scenes' | 'globalFields';
type MasterResourceValue = Customer | Material | RobotModel | Scene | GlobalField;

function decodeMasterValue(kind: MasterResourceKind, resource: JsonValue): MasterResourceValue {
  if (kind === 'customers') return decodeCustomerForm(resource).value;
  if (kind === 'materials') return decodeMaterialForm(resource, resourceAttachmentResolver).value;
  if (kind === 'robotModels') return decodeRobotModelForm(resource).value;
  if (kind === 'scenes') return decodeSceneForm(resource).value;
  return decodeGlobalFieldForm(resource).value;
}

function encodeMasterValue(kind: MasterResourceKind, value: MasterResourceValue, current: JsonValue): JsonValue {
  if (kind === 'customers') return encodeCustomerForm(value as Customer, decodeCustomerForm(current).message);
  if (kind === 'materials') return encodeMaterialForm(
    value as Material,
    decodeMaterialForm(current, resourceAttachmentResolver).message,
    resourceAttachmentResolver,
  );
  if (kind === 'robotModels') return encodeRobotModelForm(value as RobotModel, decodeRobotModelForm(current).message);
  if (kind === 'scenes') return encodeSceneForm(value as Scene, decodeSceneForm(current).message);
  return encodeGlobalFieldForm(value as GlobalField, decodeGlobalFieldForm(current).message);
}

function createMasterResource(kind: MasterResourceKind, value: MasterResourceValue): JsonValue {
  if (kind === 'customers') return createCustomerResource(value as Customer);
  if (kind === 'materials') return createMaterialResource(value as Material);
  if (kind === 'robotModels') return createRobotModelResource(value as RobotModel);
  if (kind === 'scenes') return createSceneResource(value as Scene);
  return createGlobalFieldResource(value as GlobalField);
}

function masterPlaceholder(kind: MasterResourceKind, summary: ResourceSummary): MasterResourceValue {
  if (kind === 'customers') return customerPlaceholder(summary);
  if (kind === 'materials') return materialPlaceholder(summary);
  if (kind === 'robotModels') return robotPlaceholder(summary);
  if (kind === 'scenes') return scenePlaceholder(summary);
  return globalFieldPlaceholder(summary);
}

const resourceClient = new ApiClient({ getPassword: () => storedPassword() });

async function hydrateOwnerAttachmentReferences(
  kind: AttachmentOwnerResourceKind,
  ownerName: string,
  resources: JsonValue[],
): Promise<void> {
  const metadata = await loadReferencedAttachmentMetadata(
    resources,
    (uid) => resourceClient.getAttachment(kind, ownerName, uid),
    { concurrency: 4, shouldLoad: (uid) => !attachmentForms.has(uid) },
  );
  metadata.forEach(rememberAttachment);
}

export async function loadSummaryAttachmentMetadata(
  summaries: ResourceSummary[],
  getMetadata: (ownerName: string, uid: string) => Promise<AttachmentMetadata>,
  options: { concurrency?: number; shouldLoad?: (uid: string) => boolean } = {},
): Promise<AttachmentMetadata[]> {
  const groups = summaries.flatMap((summary) => summary.listView
    ? [{ ownerName: summary.name, resource: summary.listView }]
    : []);
  const results = await mapWithConcurrency(groups, options.concurrency ?? 4, ({ ownerName, resource }) =>
    loadReferencedAttachmentMetadata(
      [resource],
      (uid) => getMetadata(ownerName, uid),
      { concurrency: 2, shouldLoad: options.shouldLoad },
    ));
  return results.flat();
}

async function hydrateSummaryAttachmentReferences(
  kind: AttachmentOwnerResourceKind,
  summaries: ResourceSummary[],
): Promise<void> {
  const metadata = await loadSummaryAttachmentMetadata(
    summaries,
    (ownerName, uid) => resourceClient.getAttachment(kind, ownerName, uid),
    { concurrency: 4, shouldLoad: (uid) => !attachmentForms.has(uid) },
  );
  metadata.forEach(rememberAttachment);
}

const attachmentMaxSizeBytes = 100 * 1024 * 1024;
const attachmentCompletionRetryDelays = [0, 250, 750] as const;

const pendingAttachmentCompletions = new Map<string, PendingAttachmentCompletion>();

function pendingAttachmentKey(kind: AttachmentOwnerResourceKind, ownerName: string): string {
  return `${kind}:${ownerName}`;
}

function attachmentCompletionStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function retainedAttachmentCompletion(
  kind: AttachmentOwnerResourceKind,
  ownerName: string,
): PendingAttachmentCompletion | undefined {
  const pendingKey = pendingAttachmentKey(kind, ownerName);
  const cached = pendingAttachmentCompletions.get(pendingKey);
  if (cached) return cached;
  const storage = attachmentCompletionStorage();
  if (!storage) return undefined;
  try {
    const persisted = findPendingAttachmentCompletion(storage, kind, ownerName);
    if (persisted) pendingAttachmentCompletions.set(pendingKey, persisted);
    return persisted;
  } catch {
    return undefined;
  }
}

function retainAttachmentCompletion(pending: PendingAttachmentCompletion): void {
  pendingAttachmentCompletions.set(pendingAttachmentKey(pending.kind, pending.ownerName), pending);
  const storage = attachmentCompletionStorage();
  if (!storage) return;
  try {
    savePendingAttachmentCompletion(storage, pending);
  } catch {
    // The in-memory descriptor still keeps this completion retryable in the
    // current page when localStorage is unavailable or full.
  }
}

function clearAttachmentCompletion(pending: PendingAttachmentCompletion): void {
  const pendingKey = pendingAttachmentKey(pending.kind, pending.ownerName);
  if (pendingAttachmentCompletions.get(pendingKey)?.uid === pending.uid) {
    pendingAttachmentCompletions.delete(pendingKey);
  }
  const storage = attachmentCompletionStorage();
  if (!storage) return;
  try {
    removePendingAttachmentCompletion(storage, pending.kind, pending.ownerName, pending.uid);
  } catch {
    // A stale descriptor is harmless: the idempotent complete endpoint will
    // return the existing metadata on the next same-file retry.
  }
}

function retryableAttachmentCompletion(error: unknown): boolean {
  if (error instanceof ApiClientError) {
    return error.status >= 500 || error.body?.error.kind === 'STORAGE_UNAVAILABLE';
  }
  return error instanceof TypeError;
}

async function completeAttachmentWithRetry(
  kind: AttachmentOwnerResourceKind,
  ownerName: string,
  uid: string,
): Promise<AttachmentMetadata> {
  let lastError: unknown;
  for (const delay of attachmentCompletionRetryDelays) {
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      return await resourceClient.completeAttachment(kind, ownerName, uid);
    } catch (error) {
      lastError = error;
      if (!retryableAttachmentCompletion(error)) throw error;
    }
  }
  throw lastError;
}

function pendingCompletionError(pending: PendingAttachmentCompletion, error: unknown): Error {
  const detail = error instanceof Error ? `：${error.message}` : '';
  return new Error(
    `附件内容已上传，但完成登记暂时失败${detail}。完成会话 ${pending.uid} 已保留；请再次选择同一文件“${pending.fileName}”重试，无需重新上传分片。`,
  );
}

async function uploadOwnerAttachment(
  kind: AttachmentOwnerResourceKind,
  ownerName: string,
  file: File,
  onProgress: (progress: number) => void,
): Promise<RequirementAttachment> {
  const pending = retainedAttachmentCompletion(kind, ownerName);
  if (pending) {
    if (!pendingAttachmentCompletionMatchesFile(pending, file)) {
      throw new Error(`附件“${pending.fileName}”仍待完成登记；请先重新选择该文件重试。`);
    }
    onProgress(100);
    try {
      const metadata = await completeAttachmentWithRetry(kind, ownerName, pending.uid);
      const attachment = rememberAttachment(metadata);
      clearAttachmentCompletion(pending);
      return attachment;
    } catch (error) {
      throw pendingCompletionError(pending, error);
    }
  }

  let session: AttachmentUploadSession | undefined;
  let completion: PendingAttachmentCompletion | undefined;
  let completionStarted = false;
  try {
    session = await resourceClient.initializeAttachment(kind, ownerName, {
      filename: file.name,
      mediaType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    });
    for (let index = 0; index < session.partCount; index += 1) {
      const start = index * session.partSizeBytes;
      const end = Math.min(file.size, start + session.partSizeBytes);
      const partNumber = index + 1;
      const chunk = file.slice(start, end, file.type || 'application/octet-stream');
      if (session.uploadMode === 'direct') {
        const { uploadUrl } = await resourceClient.createAttachmentPartUploadUrl(
          kind,
          ownerName,
          session.uid,
          partNumber,
        );
        const etag = await resourceClient.uploadAttachmentPartDirect(uploadUrl, chunk);
        await resourceClient.recordDirectAttachmentPart(kind, ownerName, session.uid, partNumber, {
          etag,
          sizeBytes: chunk.size,
        });
      } else {
        await resourceClient.uploadAttachmentPart(kind, ownerName, session.uid, partNumber, chunk);
      }
      onProgress(Math.round(((index + 1) / session.partCount) * 100));
    }
    completion = {
      kind,
      ownerName,
      uid: session.uid,
      fileName: file.name,
      mediaType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      lastModified: file.lastModified,
    };
    completionStarted = true;
    retainAttachmentCompletion(completion);
    const metadata = await completeAttachmentWithRetry(kind, ownerName, session.uid);
    const attachment = rememberAttachment(metadata);
    clearAttachmentCompletion(completion);
    return attachment;
  } catch (error) {
    if (session && !completionStarted) {
      await resourceClient.abortAttachment(kind, ownerName, session.uid).catch(() => undefined);
    }
    if (completionStarted && completion) {
      throw pendingCompletionError(completion, error);
    }
    if (error instanceof ApiClientError && error.body?.error.kind === 'STORAGE_UNAVAILABLE') {
      throw new Error(`附件存储不可用：${error.message}`);
    }
    throw error;
  }
}

function storedPassword(): string {
  return typeof window === 'undefined' ? '' : window.localStorage.getItem(authStorageKey) || '';
}

function clearStoredPassword() {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(authStorageKey);
  }
}

function isAuthError(message: string): boolean {
  return message.includes('访问密码');
}

const emptyData = createEmptyAppViewModel();

function initialPage(): Page {
  if (typeof window === 'undefined') return 'requirements';
  const route = parseAppRoute(window.location.pathname);
  if (route) return route.page;
  const stored = window.localStorage.getItem(pageStorageKey);
  return isPage(stored) ? stored : 'requirements';
}

function isPage(value: string | null): value is Page {
  return ['requirements', 'scenes', 'globalFields', 'customers', 'materials', 'robots'].includes(value || '');
}

function latest<T extends { version: string }>(versions: T[]): T {
  return versions[versions.length - 1];
}

function activeEditableDraft<T extends { status: EntityStatus; version: string }>(versions: T[]): T | undefined {
  return [...versions].reverse().find((version) => version.status === 'draft' && !revisionIsCheckpoint(version));
}

function statusText(status: string): string {
  if (status === 'active') return '启用';
  if (status === 'inactive') return '停用';
  return status === 'confirmed' ? '已确认' : status === 'archived' ? '已归档' : '草稿';
}

function shouldShowSuccessToast(message: string): boolean {
  return Boolean(message) && !message.includes('已保存');
}

function formatShortDate(value?: string): string {
  return value ? value.slice(0, 10) : '-';
}

function formatDateTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replaceAll('/', '-');
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'export';
}

function downloadTextFile(content: string, fileName: string, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function matchesQuery(query: string, values: Array<string | number | undefined>): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return values.some((value) => String(value ?? '').toLowerCase().includes(normalized));
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

function exportReportAsPdf(report: PrintableReport) {
  const iframe = document.createElement('iframe');
  iframe.title = report.fileName;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.opacity = '0';

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    iframe.remove();
  }

  iframe.onload = () => {
    const printFrame = iframe.contentWindow;
    if (!printFrame) {
      cleanup();
      window.alert('PDF 导出初始化失败，请刷新页面后重试。');
      return;
    }
    window.setTimeout(() => {
      try {
        printFrame.onafterprint = cleanup;
        printFrame.focus();
        printFrame.print();
      } catch {
        window.alert('无法打开打印对话框，请检查浏览器打印权限后重试。');
        cleanup();
      } finally {
        window.setTimeout(cleanup, 60_000);
      }
    }, 100);
  };

  document.body.appendChild(iframe);
  const iframeDocument = iframe.contentDocument || iframe.contentWindow?.document;
  if (!iframeDocument) {
    cleanup();
    window.alert('PDF 导出初始化失败，请刷新页面后重试。');
    return;
  }
  iframeDocument.open();
  iframeDocument.write(renderPrintableReport(report));
  iframeDocument.close();
}

function exportPdfModel(model: PdfDocumentModel) {
  const rows = (items: PdfDocumentModel['trace'] = []) => items.map((item) => `${item.label}：${item.value}`).join('\n');
  exportReportAsPdf({
    title: model.title,
    subtitle: model.subtitle,
    fileName: `${safeFileName(model.title)}.pdf`,
    sections: [
      { title: '追踪信息', content: rows(model.trace) },
      ...model.sections.map((section) => ({
        title: section.heading,
        content: [rows(section.rows), ...(section.items ?? [])].filter(Boolean).join('\n'),
      })),
    ],
  });
}

function renderPrintableReport(report: PrintableReport): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(report.fileName)}</title>
  <style>
    @page { size: A4; margin: 16mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #172033;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 12px;
      line-height: 1.65;
    }
    h1, h2, h3, p { margin: 0; }
    .report-header {
      border-bottom: 2px solid #172033;
      padding-bottom: 14px;
      margin-bottom: 18px;
    }
    .report-header h1 {
      font-size: 24px;
      line-height: 1.25;
    }
    .report-header p {
      margin-top: 6px;
      color: #5f6b7a;
      font-size: 12px;
    }
    section {
      break-inside: avoid;
      margin: 0 0 16px;
    }
    h2 {
      border-left: 4px solid #2563eb;
      padding-left: 8px;
      margin-bottom: 8px;
      font-size: 15px;
    }
    .section-desc {
      color: #667085;
      margin-bottom: 8px;
    }
    pre {
      margin: 0;
      padding: 10px 12px;
      border: 1px solid #d8dee8;
      border-radius: 6px;
      background: #f8fafc;
      color: #172033;
      white-space: pre-wrap;
      word-break: break-word;
      font: inherit;
    }
    .attachments {
      display: grid;
      gap: 10px;
      margin-top: 10px;
    }
    .attachment-card {
      break-inside: avoid;
      border: 1px solid #d8dee8;
      border-radius: 6px;
      background: #f8fafc;
      padding: 10px;
    }
    .attachment-card img {
      display: block;
      max-width: 100%;
      max-height: 96mm;
      object-fit: contain;
      margin-bottom: 8px;
    }
    .attachment-card a {
      color: #1d4ed8;
      text-decoration: none;
      word-break: break-all;
    }
    .attachment-meta {
      color: #667085;
      font-size: 11px;
    }
    .footer {
      margin-top: 24px;
      padding-top: 10px;
      border-top: 1px solid #d8dee8;
      color: #667085;
      font-size: 11px;
    }
    @media print {
      body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <header class="report-header">
    <h1>${escapeHtml(report.title)}</h1>
    ${report.subtitle ? `<p>${escapeHtml(report.subtitle)}</p>` : ''}
  </header>
  ${report.sections
    .filter((section) => section.content.trim() || section.attachments?.length)
    .map(
      (section) => `<section>
    <h2>${escapeHtml(section.title)}</h2>
    ${section.description ? `<p class="section-desc">${escapeHtml(section.description)}</p>` : ''}
    ${section.content.trim() ? `<pre>${escapeHtml(section.content)}</pre>` : ''}
    ${renderPrintableAttachments(section.attachments)}
  </section>`,
    )
    .join('')}
  <div class="footer">由 coScene SOP 需求管理系统生成 · ${escapeHtml(new Date().toLocaleString('zh-CN'))}</div>
</body>
</html>`;
}

function renderPrintableAttachments(attachments: PrintableSection['attachments']): string {
  if (!attachments?.length) return '';
  return `<div class="attachments">${attachments
    .map((attachment) => {
      const meta = `${attachment.contentType || '未知类型'} · ${formatFileSize(attachment.size)} · ${formatShortDate(attachment.uploadedAt)}`;
      const name = escapeHtml(attachment.name);
      const url = attachment.url ? escapeHtml(attachment.url) : '';
      const media =
        attachment.contentType.startsWith('image/') && attachment.url
          ? `<img src="${url}" alt="${name}" />`
          : '';
      const link = attachment.url ? `<a href="${url}">${name}</a>` : `<strong>${name}</strong>`;
      return `<div class="attachment-card">${media}<div>${link}</div><div class="attachment-meta">${escapeHtml(meta)}</div></div>`;
    })
    .join('')}</div>`;
}

function escapeHtml(value: string | number | undefined | null): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stateSentence(row: InitialLocationRow): string {
  const parts = [`把 ${row.object || '物料'}`];
  const primary = [row.primaryReferences[0], row.primaryRelativePositions[0]].filter(Boolean).join('的');
  if (primary) parts.push(`放在 ${primary}`);
  if (row.supportSurfaces[0]) parts.push(`接触 ${row.supportSurfaces[0]}`);
  if (row.regions.length) parts.push(`区域为 ${row.regions.join('、')}`);
  if (row.secondaryReferences[0] || row.secondaryRelativePositions[0]) {
    parts.push(`更具体位置为 ${[row.secondaryReferences[0], row.secondaryRelativePositions[0]].filter(Boolean).join('的')}`);
  }
  if (row.poses.length) parts.push(`姿态为 ${row.poses.join('、')}`);
  if (row.forms.length) parts.push(`形态为 ${row.forms.join('、')}`);
  if (row.parameters.length) parts.push(`参数为 ${row.parameters.join('、')}`);
  return parts.join('，') + '。';
}

function materialRandomizationSentence(row: MaterialInitialRandomizationRow, options: Option[]): string {
  const materials = row.targetMaterials.length ? row.targetMaterials.join('、') : '所选物料';
  const fields = row.randomizedFields.length
    ? row.randomizedFields
      .map((field) => options.find((option) => option.value === field)?.label || field)
      .join('、')
    : '未设置';
  return `${materials} 每 ${row.changeIntervalRecords || 1} 条换一次，需要变化 ${fields}。`;
}

function publicAttachmentUrl(publicBaseUrl: string | undefined, storageKey: string): string {
  if (/^(https?:\/\/|blob:)/i.test(storageKey)) return storageKey;
  if (!publicBaseUrl) return '';
  const base = publicBaseUrl.replace(/\/+$/, '');
  const encodedKey = storageKey.split('/').map(encodeURIComponent).join('/');
  return `${base}/${encodedKey}`;
}

async function downloadStoredAttachment(attachment: RequirementAttachment) {
  const url = publicAttachmentUrl(undefined, attachment.storageKey);
  if (!url) throw new Error('该附件没有公开访问链接，无法从浏览器下载');
  const link = document.createElement('a');
  link.href = url;
  link.download = attachment.name;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function nextReadableId(values: string[], prefix: string): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`, 'i');
  const matches = values.flatMap((value) => value.match(pattern)?.[1] ?? []);
  const maxNumber = matches.reduce((max, digits) => {
    const parsed = Number.parseInt(digits, 10);
    return Number.isNaN(parsed) ? max : Math.max(max, parsed);
  }, 0);
  const width = Math.max(3, ...matches.map((digits) => digits.length));
  return `${prefix}${String(maxNumber + 1).padStart(width, '0')}`;
}

function sceneLatestUpdated(scene: Scene): string {
  const updatedAt = scene.subscenes
    .flatMap((subscene) => subscene.versions.map((version) => version.updatedAt))
    .filter(Boolean)
    .sort()
    .at(-1);
  return formatShortDate(updatedAt);
}

function nextSubsceneCode(scenes: Scene[]): string {
  return randomShortCode(scenes.flatMap((scene) => scene.subscenes.map((subscene) => subscene.code)));
}

function randomShortCode(usedCodes: string[] = [], length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const used = new Set(usedCodes.map((code) => code.toUpperCase()));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let index = 0; index < length; index += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!used.has(code)) return code;
  }
  return Date.now().toString(36).slice(-length).toUpperCase();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function findTaskSop(scenes: Scene[], selected: RequirementVersion['selectedSubscenes'][number]): SubsceneLookupResult | undefined {
  const ref = selected.taskSop;
  const sceneName = ref?.sceneName || selected.sceneName;
  if (selected.subsceneCode) {
    const versionName = ref?.version || selected.version;
    for (const scene of scenes) {
      if (sceneName && scene.name !== sceneName) continue;
      const subscene = scene.subscenes.find((item) => item.code === selected.subsceneCode);
      if (!subscene) continue;
      return {
        scene,
        subscene,
        version: versionName ? subscene.versions.find((item) => item.version === versionName) : undefined,
      };
    }
  }
  for (const scene of scenes) {
    if (scene.name !== sceneName) continue;
    const subscene = scene.subscenes.find((item) => {
      const selectedVersion = ref?.version || selected.version;
      const selectedTitle = ref?.title || selected.subsceneName;
      const version = item.versions.find((candidate) => candidate.version === selectedVersion);
      return item.name === selectedTitle || version?.title === selectedTitle;
    });
    if (!subscene) continue;
    return {
      scene,
      subscene,
      version: subscene.versions.find((item) => item.version === (ref?.version || selected.version)),
    };
  }
  return undefined;
}

function productionItemTitle(item: RequirementVersion['selectedSubscenes'][number]): string {
  return item.title || item.subsceneName || item.taskSop?.title || '未命名生产需求项';
}

function productionItemSceneName(item: RequirementVersion['selectedSubscenes'][number]): string {
  return item.taskSop?.sceneName || item.sceneName || '';
}

function productionItemKey(item: RequirementVersion['selectedSubscenes'][number]): string {
  return item.id || [productionItemSceneName(item), productionItemTitle(item), item.taskSop?.version || item.version || ''].join('::');
}

function taskSopLabel(item: RequirementVersion['selectedSubscenes'][number]): string {
  return item.taskSop?.title || item.subsceneName || '';
}

function taskSopVersion(item: RequirementVersion['selectedSubscenes'][number]): string {
  return item.taskSop?.version || item.version || '';
}

function taskSopStatus(item: RequirementVersion['selectedSubscenes'][number]): EntityStatus | undefined {
  return item.taskSop?.status;
}

function candidateTaskSopReference(candidate: CandidateSubsceneOption) {
  return {
    sceneName: candidate.sceneName,
    title: candidate.selectedVersion.title || candidate.name,
    version: candidate.selectedVersion.version,
    versionId: candidate.selectedVersion.versionId,
    parentVersionId: candidate.selectedVersion.parentVersionId,
    status: candidate.selectedVersion.status,
  };
}

function candidateTaskSopKey(candidate: CandidateSubsceneOption): string {
  return [candidate.sceneId, candidate.code, candidate.selectedVersion.version].join('::');
}

function isSameTaskSopCandidate(item: RequirementVersion['selectedSubscenes'][number], candidate: CandidateSubsceneOption): boolean {
  const ref = candidateTaskSopReference(candidate);
  return taskSopLabel(item) === ref.title && taskSopVersion(item) === ref.version && (item.taskSop?.sceneName || item.sceneName) === ref.sceneName;
}

function isSameProductionItem(
  left: RequirementVersion['selectedSubscenes'][number],
  right: RequirementVersion['selectedSubscenes'][number],
): boolean {
  return productionItemKey(left) === productionItemKey(right);
}

function stripSelectedTaskSopCode(selected: RequirementVersion['selectedSubscenes'][number]): RequirementVersion['selectedSubscenes'][number] {
  const { subsceneCode: _subsceneCode, ...rest } = selected;
  return rest;
}

export default function App() {
  const [data, setData] = useState<AppViewModel>(emptyData);
  const [resourcePages, setResourcePages] = useState<Partial<Record<ResourceKind, ResourcePageState>>>({});
  const [page, setPageState] = useState<Page>(initialPage);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [loadFailure, setLoadFailure] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedRequirementId, setSelectedRequirementId] = useState<string>('');
  const [selectedRequirementVersion, setSelectedRequirementVersion] = useState('');
  const [requirementDetailOpen, setRequirementDetailOpen] = useState(false);
  const [selectedSceneId, setSelectedSceneId] = useState('');
  const [selectedSubsceneCode, setSelectedSubsceneCode] = useState('');
  const [selectedSubsceneVersion, setSelectedSubsceneVersion] = useState('');
  const [sceneDetailOpen, setSceneDetailOpen] = useState(false);
  const [returnToRequirement, setReturnToRequirement] = useState<RequirementReturnTarget | null>(null);
  const [attachmentStorageStatus, setAttachmentStorageStatus] = useState<AttachmentStorageStatus>(defaultAttachmentStorageStatus);
  const [routeReady, setRouteReady] = useState(false);
  const resourceDetails = useRef(new Map<string, ResourceDetail>());
  const saveQueues = useRef(new ResourceSaveQueueRegistry());
  const masterDraftSyncSequence = useRef(0);
  const reviewFlows = useRef(new Map<string, DependencyReviewFlow>());
  const applyingRoute = useRef(false);
  const routeInitializing = useRef(false);
  const applyRouteRef = useRef<(route: AppRoute) => Promise<void>>(async () => undefined);
  const dataRef = useRef(data);
  const [, setSaveStateEpoch] = useState(0);

  dataRef.current = data;

  useEffect(() => saveQueues.current.subscribe(() => setSaveStateEpoch((value) => value + 1)), []);
  useEffect(() => saveQueues.current.installNavigationWarning(window), []);

  function replaceMasterValue(kind: MasterResourceKind, value: MasterResourceValue) {
    const name = resourceNameOf(value);
    if (!name) return;
    setData((current) => {
      if (kind === 'customers') {
        return { ...current, customers: replaceResourceInPlace(current.customers, value as Customer) };
      }
      if (kind === 'materials') {
        return { ...current, materials: replaceResourceInPlace(current.materials, value as Material) };
      }
      if (kind === 'robotModels') {
        return { ...current, robotModels: replaceResourceInPlace(current.robotModels, value as RobotModel) };
      }
      if (kind === 'scenes') {
        const existing = current.scenes.find((item) => resourceNameOf(item) === name);
        const next = value as Scene;
        if (existing?.subscenes.length && next.subscenes.length === 0) next.subscenes = existing.subscenes;
        return { ...current, scenes: replaceResourceInPlace(current.scenes, next) };
      }
      return { ...current, globalFields: replaceResourceInPlace(current.globalFields, value as GlobalField) };
    });
  }

  function bindMasterDetail(kind: MasterResourceKind, detail: ResourceDetail): MasterResourceValue {
    resourceDetails.current.set(detail.name, detail);
    const value = bindResource(decodeMasterValue(kind, detail.resource), detail, true);
    replaceMasterValue(kind, value);
    return value;
  }

  async function openMasterDetail<T extends MasterResourceValue>(kind: MasterResourceKind, value: T): Promise<T> {
    if (resourceLoaded(value)) return value;
    const name = resourceNameOf(value);
    if (!name) return value;
    const existing = resourceDetails.current.get(name);
    const detail = existing ?? await resourceClient.get(kind, name);
    if (kind === 'materials') await hydrateOwnerAttachmentReferences(kind, name, [detail.resource]);
    return bindMasterDetail(kind, detail) as T;
  }

  async function saveMaster<T extends MasterResourceValue>(kind: MasterResourceKind, value: T): Promise<T | undefined> {
    const name = resourceNameOf(value);
    if (!name) {
      const created = await resourceClient.create(kind, createMasterResource(kind, value));
      const bound = bindMasterDetail(kind, created.resource) as T;
      setResourcePages((current) => {
        const state = current[kind] ?? { summaries: [] };
        const { resource: _resource, ...summary } = created.resource;
        return { ...current, [kind]: { ...state, summaries: [...state.summaries, summary] } };
      });
      return bound;
    }
    const detail = resourceDetails.current.get(name) ?? await resourceClient.get(kind, name);
    const initial = bindMasterDetail(kind, detail) as T;
    let queue = saveQueues.current.get<T>(name);
    if (!queue) {
      queue = saveQueues.current.register(kind, {
        resourceName: name,
        initial: { value: initial, etag: detail.etag },
        transport: createApiResourceSaveTransport<T>({
          client: resourceClient,
          kind,
          encode: (next) => {
            const authoritative = resourceDetails.current.get(name);
            if (!authoritative) throw new Error(`资源详情未加载：${name}`);
            return encodeMasterValue(kind, next, authoritative.resource);
          },
          decode: (resource) => {
            const { resource: _resource, ...summary } = detail;
            return bindResource(decodeMasterValue(kind, resource), summary, true) as unknown as T;
          },
          onDetail: (next) => bindMasterDetail(kind, next),
        }),
      });
    }
    const state = await queue.submit(value);
    if (state.kind === 'paused-conflict' || state.kind === 'paused-retryable' || state.kind === 'paused-terminal') {
      setError(state.message);
      return undefined;
    }
    return queue.localValue;
  }

  async function loadRevisionDetails(
    kind: 'taskSops' | 'requirements' | 'robotModels',
    name: string,
  ) {
    const summaries = [];
    for await (const page of resourceClient.revisionPages(kind, name)) summaries.push(...page.items);
    return mapWithConcurrency(summaries, 4, (summary) => resourceClient.getRevision(summary.name));
  }

  function rememberResourceDetail(kind: ResourceKind, detail: ResourceDetail) {
    resourceDetails.current.set(detail.name, detail);
    const { resource: _resource, ...summary } = detail;
    setResourcePages((current) => {
      const page = current[kind] ?? { summaries: [] };
      const index = page.summaries.findIndex((item) => item.name === detail.name);
      const summaries = [...page.summaries];
      if (index >= 0) summaries[index] = summary;
      else summaries.push(summary);
      return { ...current, [kind]: { ...page, summaries } };
    });
  }

  function replaceRequirementResource(detail: ResourceDetail, revisions: Awaited<ReturnType<typeof loadRevisionDetails>>) {
    rememberResourceDetail('requirements', detail);
    const requirement = bindResource<Requirement>({
      id: decodeRequirementId(detail.resource),
      versions: decodeRequirementVersions(detail.resource, revisions, requirementContext()),
    }, detail, true);
    setData((current) => ({
      ...current,
      requirements: sortResourcesByCreationTime([
        ...current.requirements.filter((item) => resourceNameOf(item) !== detail.name),
        requirement,
      ]),
    }));
    return requirement;
  }

  function replaceTaskSopResource(detail: ResourceDetail, revisions: Awaited<ReturnType<typeof loadRevisionDetails>>) {
    rememberResourceDetail('taskSops', detail);
    const identity = decodeTaskSopIdentity(detail.resource);
    const subscene = bindResource<Subscene>({
      code: identity.code,
      name: identity.displayName,
      versions: decodeTaskSopVersions(detail.resource, revisions, taskSopContext()),
    }, detail, true);
    setData((current) => ({
      ...current,
      scenes: current.scenes.map((scene) => {
        if (resourceNameOf(scene) !== identity.sceneName) return scene;
        return {
          ...scene,
          subscenes: sortResourcesByCreationTime([
            ...scene.subscenes.filter((item) => resourceNameOf(item) !== detail.name),
            subscene,
          ]),
        };
      }),
    }));
    return { identity, subscene };
  }

  async function openRequirementResource(requirement: Requirement, force = false): Promise<Requirement> {
    if (!force && resourceLoaded(requirement)) return requirement;
    const name = resourceNameOf(requirement);
    if (!name) return requirement;
    const [detail, revisions] = await Promise.all([
      force ? resourceClient.get('requirements', name) : Promise.resolve(resourceDetails.current.get(name) ?? resourceClient.get('requirements', name)),
      loadRevisionDetails('requirements', name),
    ]);
    await hydrateOwnerAttachmentReferences('requirements', name, [detail.resource, ...revisions.map((revision) => revision.resource)]);
    return replaceRequirementResource(detail, revisions);
  }

  async function openTaskSopResource(sceneId: string, code: string, force = false): Promise<Subscene | undefined> {
    const scene = dataRef.current.scenes.find((item) => item.id === sceneId);
    const subscene = scene?.subscenes.find((item) => item.code === code);
    if (!subscene || (!force && resourceLoaded(subscene))) return subscene;
    const name = resourceNameOf(subscene);
    if (!name) return subscene;
    const [detail, revisions] = await Promise.all([
      force ? resourceClient.get('taskSops', name) : Promise.resolve(resourceDetails.current.get(name) ?? resourceClient.get('taskSops', name)),
      loadRevisionDetails('taskSops', name),
    ]);
    await hydrateOwnerAttachmentReferences('taskSops', name, [detail.resource, ...revisions.map((revision) => revision.resource)]);
    const loaded = replaceTaskSopResource(detail, revisions);
    setSelectedSubsceneCode(loaded.identity.code);
    return loaded.subscene;
  }

  async function applyAppRoute(route: AppRoute): Promise<void> {
    applyingRoute.current = true;
    try {
      setPageState(route.page);
      window.localStorage.setItem(pageStorageKey, route.page);
      setRequirementDetailOpen(false);
      setSceneDetailOpen(false);
      setReturnToRequirement(null);
      if (!route.detail) return;

      const target = await resourceClient.resolveVersionRoute(route.detail.versionId);
      if (route.detail.kind === 'requirement') {
        if (target.kind !== 'requirements') throw new Error('该版本 ID 不属于客户需求');
        const [detail, revisions] = await Promise.all([
          resourceClient.get('requirements', target.ownerName),
          loadRevisionDetails('requirements', target.ownerName),
        ]);
        await hydrateOwnerAttachmentReferences('requirements', target.ownerName, [
          detail.resource,
          ...revisions.map((revision) => revision.resource),
        ]);
        const loaded = replaceRequirementResource(detail, revisions);
        if (!loaded.versions.some((version) => version.version === target.versionLabel)) {
          throw new Error(`找不到客户需求版本 v${target.versionLabel}`);
        }
        setSelectedRequirementId(loaded.id);
        setSelectedRequirementVersion(target.versionLabel);
        setRequirementDetailOpen(true);
        return;
      }

      if (target.kind !== 'taskSops') throw new Error('该版本 ID 不属于任务 SOP');
      const [detail, revisions] = await Promise.all([
        resourceClient.get('taskSops', target.ownerName),
        loadRevisionDetails('taskSops', target.ownerName),
      ]);
      await hydrateOwnerAttachmentReferences('taskSops', target.ownerName, [
        detail.resource,
        ...revisions.map((revision) => revision.resource),
      ]);
      const loaded = replaceTaskSopResource(detail, revisions);
      if (!loaded.subscene.versions.some((version) => version.version === target.versionLabel)) {
        throw new Error(`找不到任务 SOP 版本 v${target.versionLabel}`);
      }
      const scene = dataRef.current.scenes.find((item) => resourceNameOf(item) === loaded.identity.sceneName);
      if (!scene) throw new Error('找不到任务 SOP 所属场景');
      setSelectedSceneId(scene.id);
      setSelectedSubsceneCode(loaded.subscene.code);
      setSelectedSubsceneVersion(target.versionLabel);
      setSceneDetailOpen(true);
    } finally {
      applyingRoute.current = false;
    }
  }

  applyRouteRef.current = applyAppRoute;

  function taskSopContext() {
    return {
      materialNameById: new Map(dataRef.current.materials.flatMap((item) => {
        const name = resourceNameOf(item);
        return name ? [[item.id, name] as const] : [];
      })),
      materialStateRuleNameById: new Map(dataRef.current.materialStateRules.flatMap((item) => {
        const name = resourceNameOf(item);
        return name ? [[item.id, name] as const] : [];
      })),
      attachmentNameById: attachmentResourceNames,
      attachmentByName: attachmentFormFromName,
    };
  }

  function requirementContext() {
    const robotRevisionNameById = new Map<string, string>();
    for (const robot of dataRef.current.robotModels) {
      const name = resourceNameOf(robot);
      if (!name) continue;
      const detail = resourceDetails.current.get(name);
      const summary = resourcePages.robotModels?.summaries.find((item) => item.name === name);
      const revision = detail?.currentRevision || summary?.currentRevision;
      if (revision) robotRevisionNameById.set(robot.id, revision);
    }
    return {
      customerNameById: new Map(dataRef.current.customers.flatMap((item) => {
        const name = resourceNameOf(item);
        return name ? [[item.id, name] as const] : [];
      })),
      robotRevisionNameById,
      attachmentNameById: attachmentResourceNames,
      attachmentByName: attachmentFormFromName,
      taskRevisionName: (item: RequirementVersion['selectedSubscenes'][number]) =>
        revisionNameOf(findTaskSop(dataRef.current.scenes, item)?.version),
    };
  }

  function updateResourceEtag(kind: 'taskSops' | 'requirements', detail: ResourceDetail) {
    rememberResourceDetail(kind, detail);
    setData((current) => {
      if (kind === 'requirements') {
        return {
          ...current,
          requirements: current.requirements.map((item) => resourceNameOf(item) === detail.name
            ? Object.assign(item, { __resourceEtag: detail.etag, __resourceLoaded: true })
            : item),
        };
      }
      return {
        ...current,
        scenes: current.scenes.map((scene) => ({
          ...scene,
          subscenes: scene.subscenes.map((item) => resourceNameOf(item) === detail.name
            ? Object.assign(item, { __resourceEtag: detail.etag, __resourceLoaded: true })
            : item),
        })),
      };
    });
  }

  function replaceRequirementVersion(resourceName: string, next: RequirementVersion) {
    setData((current) => ({
      ...current,
      requirements: current.requirements.map((requirement) => resourceNameOf(requirement) === resourceName
        ? { ...requirement, versions: requirement.versions.map((version) => version.version === next.version ? next : version) }
        : requirement),
    }));
  }

  function replaceTaskSopVersion(resourceName: string, next: SubsceneVersion) {
    setData((current) => ({
      ...current,
      scenes: current.scenes.map((scene) => ({
        ...scene,
        subscenes: scene.subscenes.map((subscene) => resourceNameOf(subscene) === resourceName
          ? { ...subscene, versions: subscene.versions.map((version) => version.version === next.version ? next : version) }
          : subscene),
      })),
    }));
  }

  async function saveRequirementDraft(
    requirement: Requirement,
    selected: RequirementVersion,
    patch: Partial<RequirementVersion>,
  ): Promise<RequirementVersion | undefined> {
    const name = resourceNameOf(requirement);
    if (!name) throw new Error('客户需求资源尚未创建');
    let detail = resourceDetails.current.get(name) ?? await resourceClient.get('requirements', name);
    let base = selected;
    if (selected.status === 'confirmed') {
      const started = await resourceClient.startDraft('requirements', name, detail.etag);
      saveQueues.current.remove(name);
      const revisions = await loadRevisionDetails('requirements', name);
      const loaded = replaceRequirementResource(started.resource, revisions);
      detail = started.resource;
      base = latest(loaded.versions);
      setSelectedRequirementVersion(base.version);
    }
    const next = { ...base, ...patch, status: 'draft' as const };
    let queue = saveQueues.current.get<RequirementVersion>(name);
    if (!queue) {
      queue = saveQueues.current.register('requirements', {
        resourceName: name,
        initial: { value: base, etag: detail.etag },
        transport: createApiResourceSaveTransport<RequirementVersion>({
          client: resourceClient,
          kind: 'requirements',
          encode: (value) => {
            const authoritative = resourceDetails.current.get(name);
            if (!authoritative) throw new Error(`资源详情未加载：${name}`);
            return encodeRequirementVersion(value, authoritative.resource, requirementContext());
          },
          decode: (resource) => {
            const versions = decodeRequirementVersions(resource, [], requirementContext());
            if (!versions.length) throw new Error(`客户需求当前版本不可编辑：${name}`);
            return latest(versions);
          },
          onDetail: (value) => updateResourceEtag('requirements', value),
        }),
      });
    }
    replaceRequirementVersion(name, next);
    const state = await queue.submit(next);
    if (state.kind === 'paused-conflict' || state.kind === 'paused-retryable' || state.kind === 'paused-terminal') {
      setError(state.message);
      return undefined;
    }
    const saved = queue.localValue;
    replaceRequirementVersion(name, saved);
    return saved;
  }

  async function saveTaskSopDraft(
    subscene: Subscene,
    selected: SubsceneVersion,
    patch: Partial<SubsceneVersion>,
  ): Promise<SubsceneVersion | undefined> {
    const name = resourceNameOf(subscene);
    if (!name) throw new Error('任务 SOP 资源尚未创建');
    let detail = resourceDetails.current.get(name) ?? await resourceClient.get('taskSops', name);
    let base = selected;
    if (selected.status === 'confirmed') {
      const started = await resourceClient.startDraft('taskSops', name, detail.etag);
      saveQueues.current.remove(name);
      const revisions = await loadRevisionDetails('taskSops', name);
      const loaded = replaceTaskSopResource(started.resource, revisions).subscene;
      detail = started.resource;
      base = latest(loaded.versions);
      setSelectedSubsceneVersion(base.version);
    }
    const next = { ...base, ...patch, status: 'draft' as const };
    let queue = saveQueues.current.get<SubsceneVersion>(name);
    if (!queue) {
      queue = saveQueues.current.register('taskSops', {
        resourceName: name,
        initial: { value: base, etag: detail.etag },
        transport: createApiResourceSaveTransport<SubsceneVersion>({
          client: resourceClient,
          kind: 'taskSops',
          encode: (value) => {
            const authoritative = resourceDetails.current.get(name);
            if (!authoritative) throw new Error(`资源详情未加载：${name}`);
            return encodeTaskSopVersion(value, authoritative.resource, taskSopContext());
          },
          decode: (resource) => {
            const versions = decodeTaskSopVersions(resource, [], taskSopContext());
            if (!versions.length) throw new Error(`任务 SOP 当前版本不可编辑：${name}`);
            return latest(versions);
          },
          onDetail: (value) => updateResourceEtag('taskSops', value),
        }),
      });
    }
    replaceTaskSopVersion(name, next);
    const state = await queue.submit(next);
    if (state.kind === 'paused-conflict' || state.kind === 'paused-retryable' || state.kind === 'paused-terminal') {
      setError(state.message);
      return undefined;
    }
    const saved = queue.localValue;
    replaceTaskSopVersion(name, saved);
    return saved;
  }

  async function confirmRoot(kind: 'taskSops' | 'requirements', value: Subscene | Requirement) {
    const name = resourceNameOf(value);
    if (!name) throw new Error('资源尚未创建');
    const pendingQueue = saveQueues.current.get(name);
    if (pendingQueue) {
      await pendingQueue.whenSettled();
      if (pendingQueue.hasUnsavedChanges) throw new Error('仍有尚未成功保存的本地修改，处理保存冲突后才能确认版本');
    }
    const detail = resourceDetails.current.get(name) ?? await resourceClient.get(kind, name);
    let flow = reviewFlows.current.get(name);
    if (!flow || flow.state.kind === 'confirmed') {
      flow = new DependencyReviewFlow({ api: resourceClient, kind, resourceName: name, initialEtag: detail.etag });
      reviewFlows.current.set(name, flow);
    }
    await flow.requestConfirmation();
    if (flow.state.kind === 'review-required') {
      const proposal = flow.state.proposal;
      const count = proposal.added.length + proposal.changed.length + proposal.removed.length;
      if (!window.confirm(`确认冻结当前直接依赖？本次审阅包含 ${count} 项变化。确认后请再次点击“确认”完成版本冻结。`)) {
        flow.cancel();
        return;
      }
      await flow.accept();
      const acceptedState = flow.state as { kind: string };
      if (acceptedState.kind === 'acknowledged') {
        const next = await resourceClient.get(kind, name);
        updateResourceEtag(kind, next);
        if (kind === 'taskSops') {
          await flow.requestConfirmation();
        } else {
          setMessage('依赖审阅已确认，请再次点击确认版本');
          return;
        }
      }
    }
    if (flow.state.kind === 'confirmed') {
      const result = flow.state.result;
      const revisions = await loadRevisionDetails(kind, name);
      saveQueues.current.remove(name);
      if (kind === 'requirements') {
        replaceRequirementResource(result.resource, revisions);
        setSelectedRequirementVersion(result.revision.versionLabel);
      } else {
        replaceTaskSopResource(result.resource, revisions);
        setSelectedSubsceneVersion(result.revision.versionLabel);
      }
      reviewFlows.current.delete(name);
      setMessage(kind === 'requirements' ? '客户需求版本已确认' : '任务 SOP 版本已确认');
      return;
    }
    if (flow.state.kind === 'failed') throw new Error(flow.state.message);
  }

  async function requirementExportResponse(
    requirement: Requirement,
    version: RequirementVersion,
    format: 'yaml' | 'pdf',
  ): Promise<Response> {
    const revisionName = revisionNameOf(version);
    if (revisionName) return resourceClient.exportRevision(revisionName, format);

    const name = resourceNameOf(requirement);
    if (!name) throw new Error('客户需求资源尚未创建');
    const pendingQueue = saveQueues.current.get(name);
    if (pendingQueue) {
      await pendingQueue.whenSettled();
      if (pendingQueue.hasUnsavedChanges) {
        throw new Error('仍有尚未成功保存的修改，处理保存问题后才能导出');
      }
    }
    return resourceClient.exportDraft('requirements', name, format);
  }

  async function exportRequirementYaml(
    requirement: Requirement,
    version: RequirementVersion,
  ): Promise<ExportResult> {
    const response = await requirementExportResponse(requirement, version, 'yaml');
    return { yaml: await response.text(), path: response.url };
  }

  async function exportRequirementPdf(requirement: Requirement, version: RequirementVersion): Promise<void> {
    const response = await requirementExportResponse(requirement, version, 'pdf');
    exportPdfModel(await response.json() as PdfDocumentModel);
  }

  async function taskSopExportResponse(
    subscene: Subscene,
    version: SubsceneVersion,
    format: 'yaml' | 'pdf',
  ): Promise<Response> {
    const revisionName = revisionNameOf(version);
    if (revisionName) return resourceClient.exportRevision(revisionName, format);

    const name = resourceNameOf(subscene);
    if (!name) throw new Error('任务 SOP 资源尚未创建');
    const pendingQueue = saveQueues.current.get(name);
    if (pendingQueue) {
      await pendingQueue.whenSettled();
      if (pendingQueue.hasUnsavedChanges) {
        throw new Error('仍有尚未成功保存的修改，处理保存问题后才能导出');
      }
    }
    return resourceClient.exportDraft('taskSops', name, format);
  }

  async function exportTaskSopYaml(subscene: Subscene, version: SubsceneVersion): Promise<ExportResult> {
    const response = await taskSopExportResponse(subscene, version, 'yaml');
    return { yaml: await response.text(), path: response.url };
  }

  async function exportTaskSopPdf(subscene: Subscene, version: SubsceneVersion): Promise<void> {
    const response = await taskSopExportResponse(subscene, version, 'pdf');
    exportPdfModel(await response.json() as PdfDocumentModel);
  }

  function applyQueueValue(kind: ResourceKind, name: string, value: unknown) {
    if (kind === 'requirements') {
      replaceRequirementVersion(name, value as RequirementVersion);
      return;
    }
    if (kind === 'taskSops') {
      replaceTaskSopVersion(name, value as SubsceneVersion);
      return;
    }
    if (['customers', 'materials', 'robotModels', 'scenes', 'globalFields'].includes(kind)) {
      replaceMasterValue(
        kind as MasterResourceKind,
        markResourceDraftSync(value as MasterResourceValue, ++masterDraftSyncSequence.current),
      );
    }
  }

  async function loadMoreResources(kind: ResourceKind): Promise<void> {
    const currentPage = resourcePages[kind];
    if (!currentPage?.nextCursor || currentPage.loadingMore) return;
    setResourcePages((current) => ({
      ...current,
      [kind]: { ...currentPage, loadingMore: true, error: undefined },
    }));
    try {
      const page = await resourceClient.list(kind, { cursor: currentPage.nextCursor });
      if (kind === 'materials') await hydrateSummaryAttachmentReferences('materials', page.items);
      setResourcePages((current) => ({
        ...current,
        [kind]: {
          summaries: appendUniqueResourceSummaries(current[kind]?.summaries ?? [], page.items),
          nextCursor: page.nextCursor,
          loadingMore: false,
        },
      }));
      if (['customers', 'materials', 'robotModels', 'scenes', 'globalFields'].includes(kind)) {
        for (const summary of page.items) {
          const value = bindResource(masterPlaceholder(kind as MasterResourceKind, summary), summary, false);
          if (kind === 'scenes') {
            (value as Scene).subscenes = (resourcePages.taskSops?.summaries ?? [])
              .filter((task) => task.sceneName === summary.name)
              .map(taskPlaceholder);
          }
          replaceMasterValue(kind as MasterResourceKind, value);
        }
      } else if (kind === 'requirements') {
        setData((current) => ({
          ...current,
          requirements: sortResourcesByCreationTime([
            ...current.requirements,
            ...page.items.map(requirementPlaceholder),
          ]),
        }));
      } else if (kind === 'materialStateRules') {
        setData((current) => ({
          ...current,
          materialStateRules: appendMaterialStateRuleSummaries(current.materialStateRules, page.items),
        }));
      } else if (kind === 'taskSops') {
        setData((current) => ({
          ...current,
          scenes: appendTaskSopSummariesToScenes(current.scenes, page.items),
        }));
      }
    } catch (cause) {
      setResourcePages((current) => ({
        ...current,
        [kind]: {
          ...(current[kind] ?? { summaries: [] }), loadingMore: false,
          error: cause instanceof Error ? cause.message : String(cause),
        },
      }));
    }
  }

  function setPage(pageName: Page, options: { keepDetail?: boolean } = {}) {
    setPageState(pageName);
    window.localStorage.setItem(pageStorageKey, pageName);
    if (!options.keepDetail) {
      setRequirementDetailOpen(false);
      setSceneDetailOpen(false);
      setReturnToRequirement(null);
    }
  }

  function openRequirementFromSubscene() {
    if (!returnToRequirement) return;
    setSelectedRequirementId(returnToRequirement.requirementId);
    setSelectedRequirementVersion(returnToRequirement.version);
    setRequirementDetailOpen(true);
    setSceneDetailOpen(false);
    setReturnToRequirement(null);
    setPage('requirements', { keepDetail: true });
  }

  async function load() {
    if (saveQueues.current.hasUnsavedChanges &&
      !window.confirm('仍有尚未保存的本地修改，确定重新加载服务器数据吗？')) return;
    setLoading(true);
    setRouteReady(false);
    routeInitializing.current = false;
    setError('');
    setLoadFailure('');
    try {
      const kinds = [
        'customers', 'materials', 'robotModels', 'scenes', 'globalFields', 'materialStateRules', 'taskSops', 'requirements',
      ] as const satisfies readonly ResourceKind[];
      const results = await Promise.all(kinds.map(async (kind) => {
        if (kind !== 'materialStateRules' && kind !== 'scenes' && kind !== 'globalFields') {
          return [kind, await resourceClient.list(kind)] as const;
        }
        let summaries: ResourceSummary[] = [];
        // These resources are complete option/reference catalogs used by
        // editors, so partial pagination would silently omit valid choices.
        for await (const page of resourceClient.listPages(kind, { pageSize: 200 })) {
          summaries = appendUniqueResourceSummaries(summaries, page.items);
        }
        return [kind, { items: summaries, nextCursor: undefined }] as const;
      }));
      const pages = Object.fromEntries(results.map(([kind, result]) => [kind, {
        summaries: result.items,
        nextCursor: result.nextCursor,
      }])) as Partial<Record<ResourceKind, ResourcePageState>>;
      resourceDetails.current.clear();
      attachmentResourceNames.clear();
      attachmentForms.clear();
      await hydrateSummaryAttachmentReferences('materials', pages.materials?.summaries ?? []);
      const next = createEmptyAppViewModel();
      next.customers = (pages.customers?.summaries ?? []).map(customerPlaceholder);
      next.materials = (pages.materials?.summaries ?? []).map(materialPlaceholder);
      next.robotModels = (pages.robotModels?.summaries ?? []).map(robotPlaceholder);
      next.scenes = (pages.scenes?.summaries ?? []).map(scenePlaceholder);
      next.globalFields = (pages.globalFields?.summaries ?? []).map(globalFieldPlaceholder);
      next.materialStateRules = appendMaterialStateRuleSummaries([], pages.materialStateRules?.summaries ?? []);
      next.requirements = (pages.requirements?.summaries ?? []).map(requirementPlaceholder);

      next.scenes = appendTaskSopSummariesToScenes(next.scenes, pages.taskSops?.summaries ?? []);

      saveQueues.current.clear(true);
      reviewFlows.current.clear();
      setResourcePages(pages);
      setData(next);
      setAttachmentStorageStatus({ enabled: true, message: '附件使用资源级存储，单个文件最大 100 MiB。' });
      setLocked(false);
      setSelectedRequirementId((current) => current || next.requirements[0]?.id || '');
      setSelectedSceneId((current) => current || next.scenes[0]?.id || '');
      setSelectedSubsceneCode((current) => current || next.scenes[0]?.subscenes[0]?.code || '');
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载失败';
      if ((err instanceof ApiClientError && err.body?.error.kind === 'UNAUTHORIZED') || isAuthError(message)) {
        const hadPassword = Boolean(storedPassword());
        clearStoredPassword();
        setLocked(true);
        setError(hadPassword ? message : '');
      } else {
        // An authoritative-load failure must never fall through to empty,
        // editable forms. Keep it durable until an explicit retry succeeds.
        setLoadFailure(message);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (loading || locked || loadFailure || routeReady || routeInitializing.current) return;
    routeInitializing.current = true;
    const route = parseAppRoute(window.location.pathname) ?? { page: initialPage() };
    void applyRouteRef.current(route)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        routeInitializing.current = false;
        setRouteReady(true);
      });
  }, [loading, locked, loadFailure, routeReady]);

  useEffect(() => {
    const onPopState = () => {
      const route = parseAppRoute(window.location.pathname) ?? { page: 'requirements' as const };
      void applyRouteRef.current(route)
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!message && !error) return;
    const timer = window.setTimeout(() => {
      setMessage('');
      setError('');
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [message, error]);

  const selectedRequirement = data.requirements.find((item) => item.id === selectedRequirementId);
  const requirementVersion =
    selectedRequirement?.versions.find((item) => item.version === selectedRequirementVersion) ||
    (selectedRequirement ? latest(selectedRequirement.versions) : undefined);

  useEffect(() => {
    if (!routeReady || applyingRoute.current) return;
    let path = pageRoutePath(page);
    if (page === 'requirements' && requirementDetailOpen && selectedRequirement && requirementVersion) {
      const versionId = requirementVersion.versionId || resourceUidOf(selectedRequirement);
      if (versionId) path = requirementRoutePath(versionId);
    } else if (page === 'scenes' && sceneDetailOpen) {
      const scene = data.scenes.find((item) => item.id === selectedSceneId);
      const subscene = scene?.subscenes.find((item) => item.code === selectedSubsceneCode);
      const version = subscene?.versions.find((item) => item.version === selectedSubsceneVersion) ||
        (subscene?.versions.length ? latest(subscene.versions) : undefined);
      const versionId = version?.versionId || resourceUidOf(subscene);
      if (versionId) path = taskSopRoutePath(versionId);
    }
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  }, [
    routeReady,
    page,
    requirementDetailOpen,
    selectedRequirement,
    requirementVersion,
    sceneDetailOpen,
    data.scenes,
    selectedSceneId,
    selectedSubsceneCode,
    selectedSubsceneVersion,
  ]);

  useEffect(() => {
    if (selectedRequirement && !selectedRequirementVersion) {
      setSelectedRequirementVersion(latest(selectedRequirement.versions).version);
    }
  }, [selectedRequirement, selectedRequirementVersion]);

  async function run<T>(action: () => Promise<T>, success = ''): Promise<T | undefined> {
    setError('');
    setMessage('');
    try {
      const result = await action();
      if (shouldShowSuccessToast(success)) {
        setMessage(success);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败';
      if (isAuthError(message)) {
        clearStoredPassword();
        setLocked(true);
        setError(message);
      } else {
        setError(message);
      }
      return undefined;
    }
  }

  const saveNotices = saveQueues.current.states.filter(({ state }) => state.kind.startsWith('paused-') || state.warning);

  if (loading) {
    return <div className="loading">正在加载 SOP 需求管理...</div>;
  }

  if (locked) {
    return <PasswordGate error={error} onUnlock={() => void load()} />;
  }

  if (loadFailure) {
    return <BlockingLoadFailure message={loadFailure} onRetry={() => void load()} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">SOP</div>
          <div>
            <strong>需求管理</strong>
            <span>coScene 数据采集</span>
          </div>
        </div>
        <NavButton active={page === 'requirements'} label="客户需求" count={data.requirements.length} onClick={() => setPage('requirements')} />
        <NavButton active={page === 'scenes'} label="场景库" count={data.scenes.length} onClick={() => setPage('scenes')} />
        <NavButton active={page === 'customers'} label="客户" count={data.customers.length} onClick={() => setPage('customers')} />
        <NavButton active={page === 'materials'} label="物料" count={data.materials.length} onClick={() => setPage('materials')} />
        <NavButton active={page === 'robots'} label="机器型号" count={data.robotModels.length} onClick={() => setPage('robots')} />
        <NavButton
          active={page === 'globalFields'}
          label="全局字段"
          count={data.globalFields.length}
          onClick={() => setPage('globalFields')}
        />
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{pageTitle(page)}</h1>
            <p>{pageHint(page)}</p>
          </div>
          <button className="ghost-button" onClick={() => void load()}>
            刷新
          </button>
        </header>
        {(message || error) && (
          <div className="toast-stack" aria-live="polite">
            {message && <div className="notice success">{message}</div>}
            {error && <div className="notice error">{error}</div>}
          </div>
        )}
        {saveNotices.length > 0 && (
          <div className="toast-stack save-state-stack" aria-live="polite">
            {saveNotices.map(({ kind, resourceName, state }) => {
              const queue = saveQueues.current.get<unknown>(resourceName);
              if (!queue) return null;
              return (
                <div className={`notice ${state.kind === 'paused-conflict' ? 'warning' : state.kind.startsWith('paused-') ? 'error' : 'warning'}`} key={resourceName}>
                  <strong>{resourceName}</strong>
                  <span>{state.kind === 'paused-conflict' || state.kind === 'paused-retryable' || state.kind === 'paused-terminal'
                    ? state.message
                    : `资源行已达到 ${state.warning?.measuredBytes ?? 0} bytes`}</span>
                  <span className="button-row">
                    {state.kind === 'paused-conflict' && (
                      <>
                        <button className="text-button" onClick={() => void copyTextToClipboard(JSON.stringify(queue.localValue, null, 2))}>复制本地修改</button>
                        <button className="text-button" onClick={() => {
                          if (!window.confirm('确定丢弃本地修改并重新加载服务器版本吗？')) return;
                          queue.reloadServer(true);
                          applyQueueValue(kind, resourceName, queue.localValue);
                        }}>加载服务器版本</button>
                      </>
                    )}
                    {(state.kind === 'paused-retryable' || state.kind === 'paused-terminal') && (
                      <button className="text-button" onClick={() => void queue.retry().then(() => applyQueueValue(kind, resourceName, queue.localValue))}>重试</button>
                    )}
                    {state.warning && <button className="text-button" onClick={() => queue.dismissWarning()}>知道了</button>}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {page === 'requirements' && (
          <RequirementPage
            data={data}
            globalFields={data.globalFields}
            selectedRequirement={selectedRequirement}
            selectedVersion={requirementVersion}
            detailOpen={requirementDetailOpen}
            onDetailOpenChange={setRequirementDetailOpen}
            onSelectRequirement={async (id) => {
              const target = data.requirements.find((item) => item.id === id);
              setSelectedRequirementId(id);
              if (!target) {
                setSelectedRequirementVersion('');
                return;
              }
              const loaded = await openRequirementResource(target);
              setSelectedRequirementId(loaded.id);
              setSelectedRequirementVersion(latest(loaded.versions).version);
            }}
            onSelectVersion={setSelectedRequirementVersion}
            onCreate={async () => {
              const allowedOptions = fieldOptions(data.globalFields, 'allowed_operation');
              const acceptableOptions = fieldOptions(data.globalFields, 'acceptable_operation');
              const forbiddenOptions = fieldOptions(data.globalFields, 'forbidden_operation');
              const annotationAllowedOptions = fieldOptions(data.globalFields, 'annotation_allowed_operation');
              const annotationForbiddenOptions = fieldOptions(data.globalFields, 'annotation_forbidden_operation');
              const draft = {
                ...emptyRequirementVersion('新的客户需求'),
                customerId: data.customers[0]?.id || '',
                robotModelId: data.robotModels[0]?.id || '',
                allowedOperations: operationItemsFromOptions(allowedOptions),
                acceptableOperations: operationItemsFromOptions(acceptableOptions),
                forbiddenOperations: forbiddenGroupsFromKeys(forbiddenOptions.map((option) => option.value), forbiddenOptions),
                annotation: {
                  required: false,
                  types: [],
                  allowedOperations: operationItemsFromOptions(annotationAllowedOptions),
                  forbiddenOperations: operationItemsFromOptions(annotationForbiddenOptions),
                },
              };
              const result = await run(
                () => resourceClient.create('requirements', createRequirementResource(draft, requirementContext())),
                '已新建客户需求',
              );
              if (result) {
                const created = replaceRequirementResource(result.resource, []);
                setSelectedRequirementId(created.id);
                setSelectedRequirementVersion(latest(created.versions).version);
              }
            }}
            onSave={async (patch) => {
              if (!selectedRequirement || !requirementVersion) return false;
              const result = await run(
                () => saveRequirementDraft(selectedRequirement, requirementVersion, patch),
                requirementVersion.status === 'confirmed' ? '已创建草稿版本' : '已保存客户需求',
              );
              return Boolean(result);
            }}
            onDeleteVersion={async () => {
              if (!selectedRequirement || !requirementVersion) return;
              const name = resourceNameOf(selectedRequirement);
              const detail = name ? resourceDetails.current.get(name) : undefined;
              if (!name || !detail) return;
              const result = await run(
                () => resourceClient.discardDraft('requirements', name, detail.etag),
                '草稿版本已删除',
              );
              if (result) {
                saveQueues.current.remove(name);
                if (result.resource.archived || result.resource.lifecycle?.endsWith('ARCHIVED')) {
                  setData((current) => ({ ...current, requirements: current.requirements.filter((item) => resourceNameOf(item) !== name) }));
                  setRequirementDetailOpen(false);
                  setSelectedRequirementId('');
                  setSelectedRequirementVersion('');
                } else {
                  const revisions = await loadRevisionDetails('requirements', name);
                  const updated = replaceRequirementResource(result.resource, revisions);
                  setSelectedRequirementVersion(latest(updated.versions).version);
                }
              }
            }}
            onConfirm={async () => {
              if (!selectedRequirement || !requirementVersion) return;
              await run(() => confirmRoot('requirements', selectedRequirement));
            }}
            onExport={async () => {
              if (!selectedRequirement || !requirementVersion) return undefined;
              return run(
                () => exportRequirementYaml(selectedRequirement, requirementVersion),
                'YAML 已导出',
              );
            }}
            onExportPdf={async () => {
              if (!selectedRequirement || !requirementVersion) return;
              await run(() => exportRequirementPdf(selectedRequirement, requirementVersion), 'PDF 已生成');
            }}
            onRun={run}
            attachmentStorageStatus={attachmentStorageStatus}
            onOpenSubscene={async (sceneId, code, version) => {
              if (!selectedRequirement || !requirementVersion) return;
              const returnTarget = { requirementId: selectedRequirement.id, version: requirementVersion.version };
              const loaded = await run(() => openTaskSopResource(sceneId, code));
              const targetVersion = loaded?.versions.find((item) => item.version === version);
              if (!loaded || !targetVersion) {
                setError(`找不到需求引用的任务 SOP 版本 v${version}`);
                return;
              }
              setReturnToRequirement(returnTarget);
              setSelectedSceneId(sceneId);
              setSelectedSubsceneCode(loaded.code);
              setSelectedSubsceneVersion(targetVersion.version);
              setSceneDetailOpen(true);
              setPage('scenes', { keepDetail: true });
            }}
            pageState={resourcePages.requirements}
            onLoadMore={() => void loadMoreResources('requirements')}
            taskSopPageState={resourcePages.taskSops}
            onLoadMoreTaskSops={() => void loadMoreResources('taskSops')}
          />
        )}

        {page === 'scenes' && (
          <ScenePage
            globalFields={data.globalFields}
            materials={data.materials}
            scenes={data.scenes}
            selectedSceneId={selectedSceneId}
            selectedSubsceneCode={selectedSubsceneCode}
            selectedVersion={selectedSubsceneVersion}
            detailOpen={sceneDetailOpen}
            onSelectScene={(id) => {
              const target = data.scenes.find((item) => item.id === id);
              setSelectedSceneId(id);
              setSelectedSubsceneCode(target?.subscenes[0]?.code || '');
              setSelectedSubsceneVersion('');
              if (target) void openMasterDetail('scenes', target).catch((cause) => {
                setError(cause instanceof Error ? cause.message : String(cause));
              });
            }}
            onSelectSubscene={async (code) => {
              setSelectedSubsceneCode(code);
              const loaded = await openTaskSopResource(selectedSceneId, code);
              if (loaded) setSelectedSubsceneVersion(latest(loaded.versions).version);
            }}
            onSelectVersion={setSelectedSubsceneVersion}
            onDetailOpenChange={setSceneDetailOpen}
            onSaveScene={async (scene) => {
              const savedScene = await run(() => saveMaster('scenes', scene), '场景已保存');
              if (savedScene) {
                setSelectedSceneId(savedScene?.id || '');
                const preservedSubscene = savedScene?.subscenes.some((item) => item.code === selectedSubsceneCode)
                  ? selectedSubsceneCode
                  : savedScene?.subscenes[0]?.code || '';
                setSelectedSubsceneCode(preservedSubscene);
              }
            }}
            onSaveSubscene={async (sceneId, code, patch) => {
              const scene = dataRef.current.scenes.find((item) => item.id === sceneId);
              const subscene = scene?.subscenes.find((item) => item.code === code);
              const target = subscene?.versions.find((item) => item.version === patch.baseVersion) ||
                (subscene ? latest(subscene.versions) : undefined);
              if (!scene) return false;
              if (!subscene || !target) {
                const sceneName = resourceNameOf(scene);
                if (!sceneName) throw new Error('请先保存场景，再创建任务 SOP');
                const draft = {
                  ...emptySubsceneVersionDraft(patch.title || '新的任务 SOP'),
                  ...patch,
                  version: patch.version || '0.0.1',
                  status: 'draft',
                  sceneName: scene.name,
                  subsceneName: patch.title || '新的任务 SOP',
                  updatedAt: new Date().toISOString(),
                } as SubsceneVersion;
                const created = await run(
                  () => resourceClient.create('taskSops', createTaskSopResource(draft, sceneName, code, taskSopContext())),
                  '已新建任务 SOP',
                );
                if (created) {
                  const loaded = replaceTaskSopResource(created.resource, []);
                  setSelectedSubsceneCode(loaded.identity.code);
                  setSelectedSubsceneVersion(latest(loaded.subscene.versions).version);
                }
                return Boolean(created);
              }
              const saved = await run(
                () => saveTaskSopDraft(subscene, target, patch),
                target.status === 'confirmed' ? '已创建草稿版本' : '已保存任务 SOP 版本',
              );
              return Boolean(saved);
            }}
            onDeleteSubsceneVersion={async (sceneId, code, _version) => {
              const subscene = dataRef.current.scenes.find((item) => item.id === sceneId)?.subscenes.find((item) => item.code === code);
              const name = resourceNameOf(subscene);
              const detail = name ? resourceDetails.current.get(name) : undefined;
              if (!subscene || !name || !detail) return;
              const result = await run(() => resourceClient.discardDraft('taskSops', name, detail.etag), '草稿版本已删除');
              if (!result) return;
              saveQueues.current.remove(name);
              if (result.resource.archived || result.resource.lifecycle?.endsWith('ARCHIVED')) {
                setData((current) => ({
                  ...current,
                  scenes: current.scenes.map((item) => ({
                    ...item,
                    subscenes: item.subscenes.filter((candidate) => resourceNameOf(candidate) !== name),
                  })),
                }));
                setSceneDetailOpen(false);
                setSelectedSubsceneCode('');
                setSelectedSubsceneVersion('');
              } else {
                const revisions = await loadRevisionDetails('taskSops', name);
                const loaded = replaceTaskSopResource(result.resource, revisions).subscene;
                setSelectedSubsceneVersion(latest(loaded.versions).version);
              }
            }}
            onConfirmSubscene={async (sceneId, code, _version) => {
              const subscene = dataRef.current.scenes.find((item) => item.id === sceneId)?.subscenes.find((item) => item.code === code);
              if (!subscene) return;
              await run(() => confirmRoot('taskSops', subscene));
            }}
            onExportSubscene={async (subscene, version) => run(
              () => exportTaskSopYaml(subscene, version),
              '任务 SOP YAML 已生成',
            )}
            onExportSubscenePdf={async (subscene, version) => {
              await run(() => exportTaskSopPdf(subscene, version), 'PDF 已生成');
            }}
            onRun={run}
            attachmentStorageStatus={attachmentStorageStatus}
            returnToRequirement={returnToRequirement}
            onReturnToRequirement={openRequirementFromSubscene}
            onClearReturnToRequirement={() => setReturnToRequirement(null)}
            pageState={resourcePages.scenes}
            onLoadMoreScenes={() => void loadMoreResources('scenes')}
            taskPageState={resourcePages.taskSops}
            onLoadMoreTaskSops={() => void loadMoreResources('taskSops')}
            materialPageState={resourcePages.materials}
            onLoadMoreMaterials={() => void loadMoreResources('materials')}
          />
        )}

        {page === 'globalFields' && (
          <GlobalFieldPage
            globalFields={data.globalFields}
            onOpenField={(field) => openMasterDetail('globalFields', field) as Promise<GlobalField>}
            pageState={resourcePages.globalFields}
            onLoadMore={() => void loadMoreResources('globalFields')}
            onSaveField={async (field) => {
              return run(() => saveMaster('globalFields', field), '全局字段已保存');
            }}
          />
        )}

        {page === 'customers' && (
          <CustomerPage
            customers={data.customers}
            onOpen={(customer) => openMasterDetail('customers', customer) as Promise<Customer>}
            pageState={resourcePages.customers}
            onLoadMore={() => void loadMoreResources('customers')}
            onSave={async (customer) => {
              return run(() => saveMaster('customers', customer), '客户信息已保存');
            }}
          />
        )}
        {page === 'materials' && (
          <MaterialPage
            materials={data.materials}
            storageStatus={attachmentStorageStatus}
            onOpen={(material) => openMasterDetail('materials', material) as Promise<Material>}
            pageState={resourcePages.materials}
            onLoadMore={() => void loadMoreResources('materials')}
            onSave={async (material) => {
              const existing = data.materials.find((item) => item.id === material.id);
              const result = await run(
                () => saveMaster('materials', { ...material, images: material.images || existing?.images || [] }),
                '保存成功',
              );
              return result as Material | undefined;
            }}
          />
        )}
        {page === 'robots' && (
          <RobotPage
            robots={data.robotModels}
            onOpen={(robot) => openMasterDetail('robotModels', robot) as Promise<RobotModel>}
            pageState={resourcePages.robotModels}
            onLoadMore={() => void loadMoreResources('robotModels')}
            onSave={async (robot) => {
              return run(() => saveMaster('robotModels', robot), '机器型号已保存');
            }}
          />
        )}
      </main>
    </div>
  );
}

function BlockingLoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="auth-screen" aria-live="assertive">
      <section className="auth-panel" role="alert">
        <div className="brand-mark">SOP</div>
        <div>
          <h1>暂时无法加载业务数据</h1>
          <p>系统尚未初始化或存储暂时不可用。为避免覆盖现有数据，编辑功能已停用。</p>
        </div>
        <div className="notice error">{message}</div>
        <button type="button" className="primary-button" onClick={onRetry}>
          重新加载
        </button>
      </section>
    </main>
  );
}

function PasswordGate({ error, onUnlock }: { error: string; onUnlock: () => void }) {
  const [password, setPassword] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedPassword = password.trim();
    if (!normalizedPassword) return;
    window.localStorage.setItem(authStorageKey, normalizedPassword);
    onUnlock();
  }

  return (
    <div className="auth-screen">
      <form className="auth-panel" onSubmit={submit}>
        <div className="brand-mark">SOP</div>
        <div>
          <h1>SOP 需求管理</h1>
          <p>请输入访问密码后继续。</p>
        </div>
        {error && <div className="notice error">{error}</div>}
        <label className="field">
          <span>访问密码</span>
          <input type="password" value={password} autoFocus onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button className="primary-button" disabled={!password.trim()}>
          进入系统
        </button>
      </form>
    </div>
  );
}

function NavButton({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>
      <span>{label}</span>
      <strong>{count}</strong>
    </button>
  );
}

function pageTitle(page: Page) {
  const map: Record<Page, string> = {
    requirements: '客户需求管理',
    scenes: '场景与任务 SOP 库',
    globalFields: '全局字段管理',
    customers: '客户信息',
    materials: '物料信息',
    robots: '机器型号',
  };
  return map[page];
}

function pageHint(page: Page) {
  const map: Record<Page, string> = {
    requirements: '管理客户需求、生产需求项和对应任务 SOP 版本，确认后可导出需求 YAML。',
    scenes: '按场景维护任务 SOP 版本，确认后历史版本保持只读。',
    globalFields: '管理 SOP 表单复用字段，任务 SOP 会从这里选择标准词表。',
    customers: '管理客户和联系人，供客户需求引用。',
    materials: '管理可复用物料主数据，供任务 SOP 版本引用。',
    robots: '管理机器人型号、末端和 topic 要求。',
  };
  return map[page];
}

function SearchPanel({
  title,
  description,
  query,
  placeholder,
  count,
  actions,
  onQueryChange,
}: {
  title: string;
  description?: string;
  query: string;
  placeholder: string;
  count: number;
  actions?: ReactNode;
  onQueryChange: (value: string) => void;
}) {
  return (
    <div className="table-toolbar">
      <div className="toolbar-copy">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="table-tools">
        <label className="search-field">
          <span>搜索</span>
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={placeholder} />
        </label>
        <span className="result-count">{count} 条</span>
        {actions}
      </div>
    </div>
  );
}

function DataTable<T>({
  rows,
  columns,
  rowKey,
  selectedKey,
  emptyText = '暂无数据',
  onRowClick,
}: {
  rows: T[];
  columns: Array<DataTableColumn<T>>;
  rowKey: (item: T, index: number) => string;
  selectedKey?: string;
  emptyText?: string;
  onRowClick?: (item: T) => void;
}) {
  const gridTemplateColumns = columns.map((column) => column.width || 'minmax(120px, 1fr)').join(' ');
  const tableStyle = { gridTemplateColumns } as const;

  return (
    <div className="data-table-scroll">
      <div className="data-table" role="table" style={tableStyle}>
        <div className="data-table-row data-table-head" role="row">
          {columns.map((column) => (
            <div className={`data-table-cell align-${column.align || 'left'}`} role="columnheader" key={column.key}>
              {column.title}
            </div>
          ))}
        </div>
        {rows.length === 0 ? (
          <div className="table-empty">{emptyText}</div>
        ) : (
          rows.map((row, index) => {
            const key = rowKey(row, index);
            const clickable = Boolean(onRowClick);
            const cells = columns.map((column) => (
              <span
                className={`data-table-cell align-${column.align || 'left'} ${column.allowOverflow ? 'has-popup-control' : ''}`}
                role="cell"
                key={column.key}
              >
                {column.render(row, index)}
              </span>
            ));

            return clickable ? (
              <div
                className={`data-table-row ${selectedKey === key ? 'selected' : ''} ${clickable ? 'clickable' : ''}`}
                role="button"
                tabIndex={0}
                key={key}
                onClick={() => onRowClick?.(row)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onRowClick?.(row);
                  }
                }}
              >
                {cells}
              </div>
            ) : (
              <div className={`data-table-row ${selectedKey === key ? 'selected' : ''}`} role="row" key={key}>
                {cells}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status}`}>{statusText(status)}</span>;
}

function InfoItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="info-item">
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  );
}

function ExportMenu({ items }: { items: Array<{ label: string; disabled?: boolean; title?: string; onSelect: () => void | Promise<void> }> }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className="export-menu" ref={menuRef}>
      <button type="button" className="ghost-button" onClick={() => setOpen((current) => !current)}>
        导出
      </button>
      {open && (
        <div className="export-menu-list">
          {items.map((item) => (
            <button
              type="button"
              key={item.label}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                setOpen(false);
                void item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VersionMenu({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className="version-menu" ref={menuRef}>
      <span className="version-menu-label">版本</span>
      <button
        type="button"
        className="version-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="task-sop-version-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label || `v${value}`}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="version-menu-list" role="menu" aria-label="任务 SOP 版本">
          {options.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className={option.value === value ? 'selected' : ''}
              data-testid={`task-sop-version-${option.value}`}
              key={option.value}
              onClick={() => {
                setOpen(false);
                onChange(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Modal({
  title,
  children,
  panelClassName = '',
  closeOnBackdrop = true,
  onClose,
}: {
  title: string;
  children: ReactNode;
  panelClassName?: string;
  closeOnBackdrop?: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <section
        className={`modal-panel ${panelClassName}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-header">
          <h2>{title}</h2>
          <button className="ghost-button" onClick={onClose}>
            关闭
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function MultiEnumInput({
  value,
  options,
  placeholder,
  disabled = false,
  allowCustom = false,
  onChange,
}: {
  value: string[];
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  allowCustom?: boolean;
  onChange: (value: string[]) => void;
}) {
  const uniqueOptions = Array.from(new Set([...options, ...value].filter(Boolean)));
  return (
    <MultiSelectInput
      value={value}
      options={uniqueOptions.map((option) => ({ value: option, label: option }))}
      placeholder={placeholder || '选择枚举值'}
      disabled={disabled}
      emptyText="暂无可选项"
      allowCustom={allowCustom}
      onChange={onChange}
    />
  );
}

function SingleEnumSelect({
  value,
  options,
  placeholder,
  disabled = false,
  allowCustom = false,
  onChange,
}: {
  value: string[];
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  allowCustom?: boolean;
  onChange: (value: string[]) => void;
}) {
  const selectedValue = value[0] || '';
  const uniqueOptions = Array.from(new Set([...options, selectedValue].filter(Boolean)));
  const selectedLabel = selectedValue || placeholder || '请选择';
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 240 });
  const [customValue, setCustomValue] = useState('');

  useEffect(() => {
    if (!open) return;
    function updateMenuPosition() {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(rect.width, 240);
      setMenuStyle({
        left: Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)),
        top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 268)),
        width,
      });
    }
    function closeOnOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    }
    updateMenuPosition();
    document.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('scroll', updateMenuPosition, true);
    window.addEventListener('resize', updateMenuPosition);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('scroll', updateMenuPosition, true);
      window.removeEventListener('resize', updateMenuPosition);
    };
  }, [open]);

  function selectValue(nextValue: string) {
    onChange(nextValue ? [nextValue] : []);
    setOpen(false);
  }

  function addCustomValue() {
    const nextValue = customValue.trim();
    if (!nextValue) return;
    selectValue(nextValue);
    setCustomValue('');
  }

  if (disabled) {
    return (
      <div className="single-enum-select disabled">
        <div className="single-enum-summary">
          <span className={selectedValue ? '' : 'single-enum-placeholder'}>{selectedValue || '暂无可选项'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`single-enum-select ${open ? 'open' : ''}`} ref={containerRef}>
      <button
        type="button"
        className="single-enum-summary"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <span className={selectedValue ? '' : 'single-enum-placeholder'}>{selectedLabel}</span>
      </button>
      {open && createPortal(
        <div className="single-enum-menu" ref={menuRef} style={{ top: menuStyle.top, left: menuStyle.left, width: menuStyle.width }}>
          <button type="button" className={`single-enum-option ${!selectedValue ? 'selected' : ''}`} onClick={() => selectValue('')}>
            {placeholder || '请选择'}
          </button>
          {uniqueOptions.map((option) => (
            <button
              type="button"
              className={`single-enum-option ${selectedValue === option ? 'selected' : ''}`}
              key={option}
              onClick={() => selectValue(option)}
            >
              {option}
            </button>
          ))}
          {allowCustom && (
            <div className="single-enum-custom">
              <input
                value={customValue}
                placeholder="新增当前任务 SOP 字段"
                onChange={(event) => setCustomValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addCustomValue();
                  }
                }}
              />
              <button type="button" className="ghost-button" onClick={addCustomValue}>
                新增
              </button>
            </div>
          )}
        </div>
      , document.body)}
    </div>
  );
}

function MultiSelectInput({
  value,
  options,
  placeholder,
  disabled = false,
  emptyText = '暂无可选项',
  allowCustom = false,
  onChange,
}: {
  value: string[];
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  allowCustom?: boolean;
  onChange: (value: string[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 240 });
  const [customValue, setCustomValue] = useState('');
  const selectedOptions = value.map((item) => options.find((option) => option.value === item) || { value: item, label: item });
  const allOptions = uniqueOptions([...options, ...selectedOptions]);
  const summaryText = value.length > 0 ? selectedOptions.map((option) => option.label).join('、') : placeholder || '选择字段';

  useEffect(() => {
    if (!open) return;
    function updateMenuPosition() {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(rect.width, 240);
      setMenuStyle({
        left: Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)),
        top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 268)),
        width,
      });
    }
    function closeOnOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    }
    updateMenuPosition();
    document.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('scroll', updateMenuPosition, true);
    window.addEventListener('resize', updateMenuPosition);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('scroll', updateMenuPosition, true);
      window.removeEventListener('resize', updateMenuPosition);
    };
  }, [open]);

  const toggleValue = (target: string) => {
    if (value.includes(target)) {
      onChange(value.filter((item) => item !== target));
      return;
    }
    onChange([...value, target]);
  };

  const addCustomValue = () => {
    const nextValue = customValue.trim();
    if (!nextValue) return;
    if (!value.includes(nextValue)) {
      onChange([...value, nextValue]);
    }
    setCustomValue('');
  };

  if (disabled) {
    return (
      <div className="multi-select-dropdown disabled">
        <div className="multi-select-summary">
          {selectedOptions.length > 0 ? (
            <span className="multi-select-values">{summaryText}</span>
          ) : (
            <span className="multi-select-placeholder">{emptyText}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`multi-select-dropdown ${open ? 'open' : ''}`} ref={containerRef}>
      <button
        type="button"
        className="multi-select-summary"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        {selectedOptions.length > 0 ? (
          <span className="multi-select-values">{summaryText}</span>
        ) : (
          <span className="multi-select-placeholder">{allOptions.length ? placeholder || '选择字段' : emptyText}</span>
        )}
      </button>
      {open && createPortal(
        <div
          className="multi-select-menu"
          ref={menuRef}
          style={{ top: menuStyle.top, left: menuStyle.left, width: menuStyle.width }}
        >
          {allOptions.length === 0 ? (
            <div className="multi-select-empty">{emptyText}</div>
          ) : (
            allOptions.map((option) => (
              <label className="multi-select-option" key={`${option.category || ''}-${option.value}`}>
                <input type="checkbox" checked={value.includes(option.value)} onChange={() => toggleValue(option.value)} />
                <span>{option.category ? `${option.category} / ${option.label}` : option.label}</span>
              </label>
            ))
          )}
          {allowCustom && (
            <div className="multi-select-custom">
              <input
                value={customValue}
                placeholder="新增当前任务 SOP 字段"
                onChange={(event) => setCustomValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addCustomValue();
                  }
                }}
              />
              <button type="button" className="ghost-button" onClick={addCustomValue}>
                新增
              </button>
            </div>
          )}
        </div>
      , document.body)}
    </div>
  );
}

function fieldOptions(fields: GlobalField[], group: GlobalFieldGroup, includeValues: string[] = []): Option[] {
  const activeOptions = fields
    .filter((field) => field.group === group && field.status === 'active')
    .map(fieldToOption);
  const missingOptions = includeValues
    .filter((value) => value && !activeOptions.some((option) => option.value === value))
    .map((value) => ({ value, label: value }));
  return uniqueOptions([...activeOptions, ...missingOptions]);
}

function fieldToOption(field: GlobalField): Option {
  return {
    value: field.value,
    label: field.label || field.value,
    description: field.description,
  };
}

function uniqueOptions(options: Option[]): Option[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.category || ''}:${option.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedFieldId(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function globalFieldValueForStoredField(
  field: { field: string; displayName?: string },
  options: Option[],
): string {
  const candidates = [field.displayName || '', field.field].filter(Boolean);
  const direct = options.find((option) =>
    candidates.some((candidate) => candidate === option.value || candidate === option.label));
  if (direct) return direct.value;

  const prefixed = options.find((option) => {
    const optionId = normalizedFieldId(option.value);
    if (!optionId) return false;
    return candidates.some((candidate) => {
      const candidateId = normalizedFieldId(candidate);
      return candidateId === optionId || candidateId.startsWith(`${optionId}-`);
    });
  });
  return prefixed?.value || field.displayName || field.field;
}

function RequirementPage({
  data,
  globalFields,
  selectedRequirement,
  selectedVersion,
  detailOpen,
  onDetailOpenChange,
  onSelectRequirement,
  onSelectVersion,
  onCreate,
  onSave,
  onDeleteVersion,
  onConfirm,
  onExport,
  onExportPdf,
  onRun,
  attachmentStorageStatus,
  onOpenSubscene,
  pageState,
  onLoadMore,
  taskSopPageState,
  onLoadMoreTaskSops,
}: {
  data: AppViewModel;
  globalFields: GlobalField[];
  selectedRequirement?: Requirement;
  selectedVersion?: RequirementVersion;
  detailOpen: boolean;
  onDetailOpenChange: (open: boolean) => void;
  onSelectRequirement: (id: string) => Promise<void>;
  onSelectVersion: (version: string) => void;
  onCreate: () => Promise<void>;
  onSave: (patch: Partial<RequirementVersion>) => Promise<boolean>;
  onDeleteVersion: () => Promise<void>;
  onConfirm: () => Promise<void>;
  onExport: () => Promise<ExportResult | undefined>;
  onExportPdf: () => Promise<void>;
  onRun: <T>(action: () => Promise<T>, success: string) => Promise<T | undefined>;
  attachmentStorageStatus: AttachmentStorageStatus;
  onOpenSubscene: (sceneId: string, code: string, version: string) => Promise<void>;
  pageState?: ResourcePageState;
  onLoadMore: () => void;
  taskSopPageState?: ResourcePageState;
  onLoadMoreTaskSops: () => void;
}) {
  const [requirementQuery, setRequirementQuery] = useState('');
  const [subsceneQuery, setSubsceneQuery] = useState('');
  const [taskSopPickerItemId, setTaskSopPickerItemId] = useState('');
  const [candidateVersionSelections, setCandidateVersionSelections] = useState<Record<string, string>>({});
  const [attachmentUpload, setAttachmentUpload] = useState<{ fileName: string; progress: number } | null>(null);

  const candidateSubscenes = useMemo(() => {
    const items: CandidateSubsceneOption[] = [];
    for (const scene of data.scenes) {
      for (const subscene of scene.subscenes) {
        const sortedVersions = [...subscene.versions].reverse();
        const defaultVersion = sortedVersions[0] || latest(subscene.versions);
        const selectedVersionName = candidateVersionSelections[subscene.code] || defaultVersion.version;
        const selectedCandidateVersion = subscene.versions.find((item) => item.version === selectedVersionName) || defaultVersion;
        items.push({
          sceneId: scene.id,
          sceneName: scene.name,
          code: subscene.code,
          name: subscene.name,
          versions: sortedVersions,
          selectedVersion: selectedCandidateVersion,
        });
      }
    }
    return items.filter(
      (item) =>
        !subsceneQuery ||
        item.code.toLowerCase().includes(subsceneQuery.toLowerCase()) ||
        item.name.toLowerCase().includes(subsceneQuery.toLowerCase()) ||
        item.selectedVersion.title.toLowerCase().includes(subsceneQuery.toLowerCase()) ||
        item.sceneName.toLowerCase().includes(subsceneQuery.toLowerCase()),
    );
  }, [data.scenes, subsceneQuery, candidateVersionSelections]);

  const filteredRequirements = data.requirements.filter((requirement) => {
    const current = latest(requirement.versions);
    const customer = data.customers.find((item) => item.id === current.customerId);
    const robot = data.robotModels.find((item) => item.id === current.robotModelId);
    return matchesQuery(requirementQuery, [
      requirement.id,
      current.title,
      current.projectName,
      current.status,
      current.version,
      customer?.name,
      robot?.model,
      robot?.brand,
    ]);
  });
  const taskSopPickerItem = selectedVersion?.selectedSubscenes.find((item) => productionItemKey(item) === taskSopPickerItemId);
  const selectedSubsceneGroups = selectedVersion
    ? Array.from(
        selectedVersion.selectedSubscenes.reduce((groups, item) => {
          const sceneName = productionItemSceneName(item) || '未选择任务 SOP';
          const rows = groups.get(sceneName) || [];
          rows.push(item);
          groups.set(sceneName, rows);
          return groups;
        }, new Map<string, RequirementVersion['selectedSubscenes']>()),
      )
    : [];
  const selectedSubsceneDurationTotal =
    selectedVersion?.selectedSubscenes.reduce((total, item) => total + (Number(item.targetDurationHours) || 0), 0) || 0;
  const durationDelta = selectedVersion ? selectedSubsceneDurationTotal - (Number(selectedVersion.requiredDurationHours) || 0) : 0;
  const missingSelectedSubscenes =
    selectedVersion?.selectedSubscenes.filter((item) => !taskSopVersion(item) || !findTaskSop(data.scenes, item)) || [];
  const unconfirmedSelectedSubscenes =
    selectedVersion?.selectedSubscenes.filter((item) => {
      const target = findTaskSop(data.scenes, item);
      return (target?.version?.status || taskSopStatus(item)) !== 'confirmed';
    }) || [];

  const requirementColumns: Array<DataTableColumn<Requirement>> = [
    {
      key: 'title',
      title: '需求名称',
      width: 'minmax(160px, 1.6fr)',
      render: (requirement) => latest(requirement.versions).title,
    },
    {
      key: 'customer',
      title: '客户',
      width: 'minmax(80px, 0.8fr)',
      render: (requirement) =>
        data.customers.find((item) => item.id === latest(requirement.versions).customerId)?.name || '-',
    },
    {
      key: 'project',
      title: '项目名称',
      width: 'minmax(100px, 1fr)',
      render: (requirement) => latest(requirement.versions).projectName || '-',
    },
    {
      key: 'status',
      title: '状态',
      width: '78px',
      render: (requirement) => <StatusBadge status={latest(requirement.versions).status} />,
    },
    {
      key: 'version',
      title: '版本',
      width: '72px',
      render: (requirement) => `v${latest(requirement.versions).version}`,
    },
    {
      key: 'subscenes',
      title: '生产需求项',
      width: '88px',
      align: 'right',
      render: requirementProductionItemCount,
    },
    {
      key: 'duration',
      title: '总时长',
      width: '76px',
      align: 'right',
      render: (requirement) => `${latest(requirement.versions).requiredDurationHours || 0} h`,
    },
    {
      key: 'deadline',
      title: '截止日期',
      width: '112px',
      render: (requirement) => formatShortDate(latest(requirement.versions).deadline),
    },
    {
      key: 'action',
      title: '操作',
      width: '54px',
      render: (requirement) => (
        <button
          className="text-button"
          onClick={(event) => {
            event.stopPropagation();
            openRequirementDetail(requirement.id);
          }}
        >
          查看
        </button>
      ),
    },
  ];

  const selectedSubsceneColumns: Array<DataTableColumn<RequirementVersion['selectedSubscenes'][number]>> = [
    {
      key: 'title',
      title: '生产需求项',
      width: 'minmax(190px, 1.2fr)',
      render: (item) => (
        <InlineTextInput
          disabled={readonly}
          value={productionItemTitle(item)}
          placeholder="需求项名称"
          onCommit={(title) => {
            if (readonly || !selectedVersion) return;
            const selectedSubscenes = selectedVersion.selectedSubscenes.map((current) =>
              isSameProductionItem(current, item) ? { ...current, title } : current,
            );
            void onSave({ selectedSubscenes: selectedSubscenes.map(stripSelectedTaskSopCode) });
          }}
        />
      ),
    },
    {
      key: 'description',
      title: '描述',
      width: '160px',
      render: (item) => (
        <LongTextDialogEditor
          title="生产需求项描述"
          value={item.description || ''}
          disabled={readonly}
          placeholder="填写客户对这个需求项的描述"
          onChange={(description) => {
            if (readonly || !selectedVersion) return;
            const selectedSubscenes = selectedVersion.selectedSubscenes.map((current) =>
              isSameProductionItem(current, item) ? { ...current, description } : current,
            );
            void onSave({ selectedSubscenes: selectedSubscenes.map(stripSelectedTaskSopCode) });
          }}
        />
      ),
    },
    {
      key: 'taskSop',
      title: '任务 SOP',
      width: 'minmax(180px, 1fr)',
      render: (item) => taskSopLabel(item) || <span className="muted-text">未选择任务 SOP</span>,
    },
    { key: 'version', title: 'SOP 版本', width: '90px', render: (item) => (taskSopVersion(item) ? `v${taskSopVersion(item)}` : '-') },
    {
      key: 'status',
      title: '状态',
      width: '96px',
      render: (item) => {
        const target = findTaskSop(data.scenes, item);
        const status = target?.version?.status || taskSopStatus(item);
        return status ? <StatusBadge status={status} /> : '未选择';
      },
    },
    {
      key: 'duration',
      title: '目标采集时长',
      width: '160px',
      render: (item) => (
        <span className="inline-edit">
          <InlineNumberInput
            disabled={readonly}
            value={item.targetDurationHours}
            onCommit={(targetDurationHours) => {
              if (readonly) return;
              const selectedSubscenes = selectedVersion?.selectedSubscenes.map((current) =>
                isSameProductionItem(current, item)
                  ? { ...current, targetDurationHours }
                  : current,
              );
              if (selectedSubscenes) void onSave({ selectedSubscenes: selectedSubscenes.map(stripSelectedTaskSopCode) });
            }}
          />
          h
        </span>
      ),
    },
    {
      key: 'count',
      title: '目标采集数量',
      width: '210px',
      render: (item) => (
        <span className="inline-edit">
          <InlineNumberInput
            className="target-count-input"
            disabled={readonly}
            value={item.targetCollectionCount || 0}
            onCommit={(targetCollectionCount) => {
              if (readonly) return;
              const selectedSubscenes = selectedVersion?.selectedSubscenes.map((current) =>
                isSameProductionItem(current, item)
                  ? { ...current, targetCollectionCount }
                  : current,
              );
              if (selectedSubscenes) void onSave({ selectedSubscenes: selectedSubscenes.map(stripSelectedTaskSopCode) });
            }}
          />
          条
        </span>
      ),
    },
    {
      key: 'action',
      title: '操作',
      width: '186px',
      render: (item) => (
        <span className="table-action-row">
          <button
            className="text-button"
            disabled={readonly}
            onClick={() => setTaskSopPickerItemId(productionItemKey(item))}
          >
            选择 SOP
          </button>
          <button
            className="text-button"
            disabled={!findTaskSop(data.scenes, item)}
            onClick={() => {
              const target = findTaskSop(data.scenes, item);
              const version = taskSopVersion(item);
              if (target && version) void onOpenSubscene(target.scene.id, target.subscene.code, version);
            }}
          >
            查看
          </button>
          <button
            className="text-button danger"
            disabled={readonly}
            onClick={() => {
              if (readonly || !selectedVersion) return;
              void onSave({
                selectedSubscenes: selectedVersion.selectedSubscenes.filter(
                  (current) => !isSameProductionItem(current, item),
                ).map(stripSelectedTaskSopCode),
              });
            }}
          >
            移除
          </button>
        </span>
      ),
    },
  ];

  const candidateSubsceneColumns: Array<DataTableColumn<CandidateSubsceneOption>> = [
    { key: 'name', title: '任务 SOP', width: 'minmax(180px, 1.4fr)', render: (item) => item.selectedVersion.title || item.name },
    { key: 'scene', title: '场景', width: '140px', render: (item) => item.sceneName },
    {
      key: 'version',
      title: '版本',
      width: '130px',
      render: (item) => (
        <select
          value={item.selectedVersion.version}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            event.stopPropagation();
            setCandidateVersionSelections((current) => ({ ...current, [item.code]: event.target.value }));
          }}
        >
          {item.versions.map((version) => (
            <option value={version.version} key={version.version}>
              v{version.version}
            </option>
          ))}
        </select>
      ),
    },
    { key: 'status', title: '状态', width: '96px', render: (item) => <StatusBadge status={item.selectedVersion.status} /> },
    {
      key: 'importStatus',
      title: '选择状态',
      width: '100px',
      render: (item) => (taskSopPickerItem && isSameTaskSopCandidate(taskSopPickerItem, item) ? '当前选择' : '可选择'),
    },
  ];

  async function openRequirementDetail(id: string) {
    await onSelectRequirement(id);
    onDetailOpenChange(true);
  }

  async function createRequirementAndOpen() {
    await onCreate();
    onDetailOpenChange(true);
  }

  function closeRequirementDetail() {
    onDetailOpenChange(false);
  }

  if (!detailOpen || !selectedRequirement || !selectedVersion) {
    return (
      <div className="page-stack">
        <section className="panel table-panel requirement-list-panel">
          <SearchPanel
            title="需求列表"
            description="按需求名称、客户、项目、状态或版本搜索，点击行进入详情页"
            query={requirementQuery}
            placeholder="搜索需求名称、客户、项目"
            count={filteredRequirements.length}
            onQueryChange={setRequirementQuery}
            actions={
              <>
                {(pageState?.nextCursor || pageState?.error) && (
                  <button className="ghost-button" disabled={pageState.loadingMore} onClick={onLoadMore}>
                    {pageState.loadingMore ? '正在加载…' : '加载更多'}
                  </button>
                )}
                <button className="primary-button" onClick={() => void createRequirementAndOpen()}>
                  新建需求
                </button>
              </>
            }
          />
          <DataTable
            rows={filteredRequirements}
            columns={requirementColumns}
            rowKey={(requirement) => requirement.id}
            emptyText="还没有客户需求"
            onRowClick={(requirement) => openRequirementDetail(requirement.id)}
          />
        </section>
      </div>
    );
  }

  const checkpoint = revisionIsCheckpoint(selectedVersion);
  const currentDraft = activeEditableDraft(selectedRequirement.versions);
  const readonly = selectedVersion.status === 'confirmed' || checkpoint;
  const selectedAllowedOperations = selectedVersion.allowedOperations.map((item) => item.operation);
  const selectedAcceptableOperations = (selectedVersion.acceptableOperations || []).map((item) => item.operation);
  const selectedForbiddenOperations = selectedVersion.forbiddenOperations.flatMap((group) =>
    group.operations.map((item) => (group.category ? `${group.category}/${item.operation}` : item.operation)),
  );
  const forbiddenOptions = fieldOptions(
    globalFields,
    'forbidden_operation',
    selectedForbiddenOperations,
  );
  const allowedOperationOptions = fieldOptions(globalFields, 'allowed_operation', selectedAllowedOperations);
  const acceptableOperationOptions = fieldOptions(globalFields, 'acceptable_operation', selectedAcceptableOperations);
  const selectedAnnotationAllowedOperations = selectedVersion.annotation.allowedOperations?.map((item) => item.operation) || [];
  const selectedAnnotationForbiddenOperations = selectedVersion.annotation.forbiddenOperations?.map((item) => item.operation) || [];
  const annotationAllowedOptions = fieldOptions(globalFields, 'annotation_allowed_operation', selectedAnnotationAllowedOperations);
  const annotationForbiddenOptions = fieldOptions(globalFields, 'annotation_forbidden_operation', selectedAnnotationForbiddenOperations);
  const yamlDownloadFileName = `${safeFileName(selectedVersion.title)}-${selectedVersion.version}.yaml`;

  async function downloadYaml() {
    const result = await onExport();
    if (!result) return;
    downloadTextFile(result.yaml, yamlDownloadFileName, 'application/x-yaml;charset=utf-8');
  }

  function createDraftFromCurrentVersion() {
    if (currentDraft) {
      onSelectVersion(currentDraft.version);
      return;
    }
    void onSave({});
  }

  function addProductionRequirementItem() {
    if (!selectedVersion || readonly) return;
    const nextItems = [
      ...selectedVersion.selectedSubscenes,
      {
        title: `生产需求项 ${selectedVersion.selectedSubscenes.length + 1}`,
        description: '',
        sceneName: '',
        targetDurationHours: 0,
        targetCollectionCount: 0,
      },
    ];
    void onSave({
      selectedSubscenes: nextItems.map(stripSelectedTaskSopCode),
    });
  }

  function selectTaskSopForProductionItem(candidate: CandidateSubsceneOption) {
    if (!selectedVersion || readonly || !taskSopPickerItem) return;
    const ref = candidateTaskSopReference(candidate);
    const selectedSubscenes = selectedVersion.selectedSubscenes.map((current) =>
      isSameProductionItem(current, taskSopPickerItem)
        ? {
            ...current,
            sceneName: ref.sceneName,
            subsceneName: ref.title,
            version: ref.version,
            taskSop: ref,
          }
        : current,
    );
    void onSave({
      requestedScenes: Array.from(new Set(selectedSubscenes.map((current) => productionItemSceneName(current)).filter(Boolean))),
      selectedSubscenes: selectedSubscenes.map(stripSelectedTaskSopCode),
    });
    setTaskSopPickerItemId('');
  }

  async function uploadRequirementAttachment(file: File) {
    if (!selectedRequirement || !selectedVersion || readonly) return;
    const ownerName = resourceNameOf(selectedRequirement);
    if (!ownerName) throw new Error('客户需求资源尚未创建');
    if (file.size > attachmentMaxSizeBytes) {
      window.alert('单个附件不能超过 100 MiB');
      return;
    }
    try {
      setAttachmentUpload({ fileName: file.name, progress: 0 });
      const attachment = await uploadOwnerAttachment(
        'requirements',
        ownerName,
        file,
        (progress) => setAttachmentUpload({ fileName: file.name, progress }),
      );
      const linked = await onSave({ attachments: [...(selectedVersion.attachments ?? []), attachment] });
      if (!linked) throw new Error('附件已上传，但客户需求引用尚未保存；请先处理保存冲突');
    } finally {
      setAttachmentUpload(null);
    }
  }

  async function downloadRequirementAttachment(attachment: RequirementAttachment) {
    await downloadStoredAttachment(attachment);
  }

  function saveAllowedOperations(operations: string[]) {
    void onSave({
      allowedOperations: operations.map((operation) => {
        const option = allowedOperationOptions.find((item) => item.value === operation);
        return { operation, note: option?.description || '' };
      }),
    });
  }

  function saveAcceptableOperations(operations: string[]) {
    void onSave({
      acceptableOperations: operations.map((operation) => {
        const option = acceptableOperationOptions.find((item) => item.value === operation);
        return { operation, note: option?.description || '' };
      }),
    });
  }

  function saveForbiddenOperations(operations: string[]) {
    void onSave({ forbiddenOperations: forbiddenGroupsFromKeys(operations, forbiddenOptions) });
  }

  function saveAnnotationAllowedOperations(operations: string[]) {
    if (!selectedVersion) return;
    void onSave({
      annotation: {
        ...selectedVersion.annotation,
        allowedOperations: operations.map((operation) => {
          const option = annotationAllowedOptions.find((item) => item.value === operation);
          return { operation, note: option?.description || '' };
        }),
      },
    });
  }

  function saveAnnotationForbiddenOperations(operations: string[]) {
    if (!selectedVersion) return;
    void onSave({
      annotation: {
        ...selectedVersion.annotation,
        forbiddenOperations: operations.map((operation) => {
          const option = annotationForbiddenOptions.find((item) => item.value === operation);
          return { operation, note: option?.description || '' };
        }),
      },
    });
  }

  const taskSopPickerModal = taskSopPickerItem && (
    <Modal title={`为“${productionItemTitle(taskSopPickerItem)}”选择任务 SOP`} onClose={() => setTaskSopPickerItemId('')}>
      <SearchPanel
        title="任务 SOP 库"
        description="按名称或场景搜索，点击行选择这个生产需求项要使用的任务 SOP 版本"
        query={subsceneQuery}
        placeholder="搜索洗漱台整理或场景名称"
        count={candidateSubscenes.length}
        onQueryChange={setSubsceneQuery}
        actions={(
          <ResourceLoadMoreButton
            state={taskSopPageState}
            onLoadMore={onLoadMoreTaskSops}
            label="加载更多任务 SOP"
          />
        )}
      />
      <DataTable
        rows={candidateSubscenes}
        columns={candidateSubsceneColumns}
        rowKey={candidateTaskSopKey}
        emptyText="没有匹配的任务 SOP"
        onRowClick={selectTaskSopForProductionItem}
      />
    </Modal>
  );

  return (
    <>
      <div className="detail-page">
        <div className="detail-page-toolbar">
          <div className="button-row">
            <button className="ghost-button" onClick={closeRequirementDetail}>
              返回需求列表
            </button>
          </div>
          <span>客户需求 / v{selectedVersion.version}</span>
        </div>
        <section className="panel detail-panel">
          <div className="panel-header">
          <div>
            <h2>{selectedVersion.title}</h2>
            <p className="version-time-meta">
              v{selectedVersion.version} · {statusText(selectedVersion.status)}
              <span>创建时间 {formatDateTime(selectedVersion.createdAt || selectedVersion.updatedAt)}</span>
              <span>更新时间 {formatDateTime(selectedVersion.updatedAt)}</span>
            </p>
          </div>
          <div className="button-row">
            <label className="version-select">
              <span>版本</span>
              <select value={selectedVersion.version} onChange={(event) => onSelectVersion(event.target.value)}>
                {selectedRequirement.versions.map((version) => (
                  <option value={version.version} key={version.version}>
                    v{version.version} · {statusText(version.status)}
                  </option>
                ))}
              </select>
            </label>
            <ExportMenu
              items={[
                {
                  label: '导出 PDF',
                  disabled: missingSelectedSubscenes.length > 0,
                  title: missingSelectedSubscenes.length > 0
                    ? '有生产需求项未选择任务 SOP，或引用的任务 SOP 版本未找到'
                    : undefined,
                  onSelect: onExportPdf,
                },
                {
                  label: '导出 YAML',
                  disabled: missingSelectedSubscenes.length > 0 || !revisionExportEligible(selectedVersion),
                  title: !revisionExportEligible(selectedVersion)
                    ? '草稿版本只能导出 PDF'
                    : missingSelectedSubscenes.length > 0
                      ? '有生产需求项未选择任务 SOP，或引用的任务 SOP 版本未找到'
                      : undefined,
                  onSelect: downloadYaml,
                },
              ]}
            />
            {selectedVersion.status === 'confirmed' ? (
              <button className="primary-button" onClick={createDraftFromCurrentVersion}>
                {currentDraft ? '进入当前草稿' : '编辑为草稿'}
              </button>
            ) : checkpoint ? (
              <span className="muted-text">导入草稿检查点（只读）</span>
            ) : (
              <>
                <button className="ghost-button danger" onClick={() => void onDeleteVersion()}>
                  删除草稿
                </button>
                <button
                  className="primary-button"
                  disabled={unconfirmedSelectedSubscenes.length > 0}
                  title={unconfirmedSelectedSubscenes.length > 0 ? '有任务 SOP 还没有确认，不能确认需求' : undefined}
                  onClick={() => void onConfirm()}
                >
                  确认版本
                </button>
              </>
            )}
          </div>
          </div>

          {checkpoint
            ? <div className="notice info">这是迁移保留的旧草稿检查点，仅供追踪，不能编辑或确认，可以导出 PDF。</div>
            : selectedVersion.status === 'confirmed' && (
              <div className="notice info">
                {currentDraft
                  ? `当前已有草稿 v${currentDraft.version}，点击“进入当前草稿”继续编辑。`
                  : '当前版本已确认，点击“编辑为草稿”会复制出新的草稿版本。'}
              </div>
            )}
          {!readonly && unconfirmedSelectedSubscenes.length > 0 && (
            <div className="notice warning">
              有 {unconfirmedSelectedSubscenes.length} 个生产需求项未选择任务 SOP，或选择的任务 SOP 还没有确认，不能确认需求：
              {unconfirmedSelectedSubscenes
                .map((item) => {
                  const label = taskSopLabel(item);
                  const version = taskSopVersion(item);
                  return `${productionItemTitle(item)}${label ? ` / ${label} v${version || '-'}` : ' / 未选择任务 SOP'}`;
                })
                .join('；')}
            </div>
          )}

          <div className="requirement-sections">
            <section className="requirement-section">
              <div className="requirement-section-header">
                <h3>基础信息</h3>
                <p>客户、项目、机器人、计划和客户原始输入</p>
              </div>
              <div className="requirement-section-grid">
                <CommitField
                  label="需求名称"
                  value={selectedVersion.title}
                  disabled={readonly}
                  onChange={(title) => void onSave({ title })}
                />
                <Field
                  label="项目名称"
                  value={selectedVersion.projectName}
                  disabled={readonly}
                  onChange={(projectName) => void onSave({ projectName })}
                />
                <SelectField
                  label="客户"
                  value={selectedVersion.customerId}
                  options={data.customers.map((item) => ({ value: item.id, label: item.name }))}
                  disabled={readonly}
                  onChange={(customerId) => void onSave({ customerId })}
                />
                <SelectField
                  label="机器人型号"
                  value={selectedVersion.robotModelId}
                  options={data.robotModels.map((item) => ({ value: item.id, label: `${item.brand} ${item.model}` }))}
                  disabled={readonly}
                  onChange={(robotModelId) => void onSave({ robotModelId })}
                />
                <Field
                  label="截止日期"
                  type="date"
                  value={selectedVersion.deadline}
                  disabled={readonly}
                  onChange={(deadline) => void onSave({ deadline })}
                />
                <Field
                  label="总目标时长（小时）"
                  type="number"
                  value={String(selectedVersion.requiredDurationHours)}
                  disabled={readonly}
                  onChange={(requiredDurationHours) => void onSave({ requiredDurationHours: Number(requiredDurationHours) })}
                />
                <TextArea
                  label="原始需求来源链接"
                  value={selectedVersion.sourceBaseUrl || ''}
                  disabled={readonly}
                  onChange={(sourceBaseUrl) => void onSave({ sourceBaseUrl })}
                />
                <TextArea
                  label="数据用途/业务目标"
                  value={selectedVersion.businessGoal}
                  disabled={readonly}
                  onChange={(businessGoal) => void onSave({ businessGoal })}
                />
                <AttachmentField
                  title="客户附件"
                  hint="单个附件不超过 100 MiB，支持分片上传"
                  attachments={selectedVersion.attachments || []}
                  disabled={readonly}
                  storageStatus={attachmentStorageStatus}
                  upload={attachmentUpload}
                  onUpload={(file) => onRun(() => uploadRequirementAttachment(file), '附件已上传').then(() => undefined)}
                  onDownload={(attachment) => onRun(() => downloadRequirementAttachment(attachment), '附件已下载').then(() => undefined)}
                  onDelete={async (attachmentId) => {
                    if (!selectedRequirement) return;
                    const ownerName = resourceNameOf(selectedRequirement);
                    if (!ownerName) throw new Error('客户需求资源尚未创建');
                    const nextAttachments = (selectedVersion.attachments ?? [])
                      .filter((attachment) => attachment.id !== attachmentId);
                    await onRun(
                      async () => {
                        if (!await onSave({ attachments: nextAttachments })) {
                          throw new Error('客户需求引用尚未保存，附件未解除关联');
                        }
                        await resourceClient.unlinkAttachment('requirements', ownerName, attachmentId);
                      },
                      '附件已删除',
                    );
                  }}
                />
              </div>
            </section>

            <section className="requirement-section">
              <div className="requirement-section-header">
                <h3>交付 / 标注 / 质检</h3>
                <p>数据交付方式、标注范围和客户抽检策略</p>
              </div>
              <div className="requirement-section-grid">
                <SelectField
                  label="交付形式"
                  value={selectedVersion.delivery.method}
                  options={fieldOptions(globalFields, 'delivery_method', [selectedVersion.delivery.method]).map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  disabled={readonly}
                  onChange={(method) => void onSave({ delivery: { ...selectedVersion.delivery, method } })}
                />
                <MultiSelectField
                  label="交付数据"
                  value={selectedVersion.delivery.formats}
                  options={fieldOptions(globalFields, 'delivery_format', selectedVersion.delivery.formats)}
                  disabled={readonly}
                  onChange={(formats) => void onSave({ delivery: { ...selectedVersion.delivery, formats } })}
                />
                <MultiSelectField
                  label="交付语言"
                  value={selectedVersion.delivery.languages.map((item) => `${item.code}:${item.name}`)}
                  options={fieldOptions(
                    globalFields,
                    'delivery_language',
                    selectedVersion.delivery.languages.map((item) => `${item.code}:${item.name}`),
                  )}
                  disabled={readonly}
                  onChange={(value) =>
                    void onSave({
                      delivery: {
                        ...selectedVersion.delivery,
                        languages: value.map((item) => {
                          const [code, name = code] = item.split(':');
                          return { code, name };
                        }),
                      },
                    })
                  }
                />
                <SelectField
                  label="是否需要标注"
                  value={selectedVersion.annotation.required ? '需要' : '不需要'}
                  options={['需要', '不需要'].map((item) => ({ value: item, label: item }))}
                  disabled={readonly}
                  onChange={(value) => void onSave({ annotation: { ...selectedVersion.annotation, required: value === '需要' } })}
                />
                <div className="field">
                  <span>标注类型</span>
                  <MultiSelectInput
                    value={selectedVersion.annotation.types}
                    options={fieldOptions(globalFields, 'annotation_type', selectedVersion.annotation.types)}
                    disabled={readonly}
                    onChange={(types) => void onSave({ annotation: { ...selectedVersion.annotation, types } })}
                  />
                </div>
                <SelectField
                  label="客户抽检策略"
                  value={selectedVersion.qualityInspection.samplingPolicy}
                  options={fieldOptions(globalFields, 'sampling_policy', [selectedVersion.qualityInspection.samplingPolicy]).map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  disabled={readonly}
                  onChange={(samplingPolicy) =>
                    void onSave({ qualityInspection: { ...selectedVersion.qualityInspection, samplingPolicy } })
                  }
                />
              </div>
            </section>

            <section className="requirement-section">
              <div className="requirement-section-header">
                <h3>全局要求</h3>
                <p>topic、随机性、补充说明，以及客户需求层面的采集和标注操作约束</p>
              </div>
              <div className="requirement-notes-grid">
                <TextArea
                  label="客户额外 topic 要求"
                  value={selectedVersion.extraTopicRequirementsText || ''}
                  disabled={readonly}
                  onChange={(extraTopicRequirementsText) => void onSave({ extraTopicRequirementsText })}
                />
                <TextArea
                  label="全局随机性要求"
                  value={selectedVersion.globalRandomizationRequirements || ''}
                  disabled={readonly}
                  onChange={(globalRandomizationRequirements) => void onSave({ globalRandomizationRequirements })}
                />
                <TextArea
                  label="其他补充说明"
                  value={selectedVersion.additionalNotes || ''}
                  disabled={readonly}
                  onChange={(additionalNotes) => void onSave({ additionalNotes })}
                />
              </div>
              <div className="requirement-operation-sections">
                <div className="operation-category">
                  <div className="operation-category-header">
                    <h4>采集操作要求</h4>
                  </div>
                  <div className="requirement-operation-grid">
                    <OperationRequirementGroup
                      title="采集操作要求"
                      value={selectedAllowedOperations}
                      options={allowedOperationOptions}
                      readOnly={readonly}
                      onChange={saveAllowedOperations}
                    />
                    <OperationRequirementGroup
                      title="不完美但可接受的采集操作"
                      value={selectedAcceptableOperations}
                      options={acceptableOperationOptions}
                      readOnly={readonly}
                      onChange={saveAcceptableOperations}
                    />
                    <OperationRequirementGroup
                      title="采集禁止操作"
                      value={selectedForbiddenOperations}
                      options={forbiddenOptions}
                      readOnly={readonly}
                      onChange={saveForbiddenOperations}
                    />
                  </div>
                </div>
                <div className="operation-category">
                  <div className="operation-category-header">
                    <h4>标注操作要求</h4>
                  </div>
                  <div className="requirement-operation-grid annotation-operation-grid">
                    <OperationRequirementGroup
                      title="标注操作要求"
                      value={selectedAnnotationAllowedOperations}
                      options={annotationAllowedOptions}
                      readOnly={readonly}
                      onChange={saveAnnotationAllowedOperations}
                    />
                    <OperationRequirementGroup
                      title="标注禁止操作"
                      value={selectedAnnotationForbiddenOperations}
                      options={annotationForbiddenOptions}
                      readOnly={readonly}
                      onChange={saveAnnotationForbiddenOperations}
                    />
                  </div>
                </div>
              </div>
            </section>

          </div>

        <div className="embedded-table">
          <div className="embedded-table-header">
            <div>
              <h3>生产需求项</h3>
              <p>先维护客户要做的需求项，再为每条需求项选择对应的任务 SOP 版本</p>
            </div>
            <div className="button-row">
              <span className="result-count">{selectedVersion.selectedSubscenes.length} 条</span>
              <button className="primary-button" disabled={readonly} onClick={addProductionRequirementItem}>
                添加生产需求项
              </button>
            </div>
          </div>
          {durationDelta !== 0 && (
            <div className="notice warning compact-notice">
              总目标时长 {Number(selectedVersion.requiredDurationHours) || 0} h，生产需求项目标时长合计{' '}
              {selectedSubsceneDurationTotal} h，{durationDelta > 0 ? '超出' : '还差'} {Math.abs(durationDelta)} h。
            </div>
          )}
          {missingSelectedSubscenes.length > 0 && (
            <div className="notice error compact-notice">
              有 {missingSelectedSubscenes.length} 个生产需求项未选择任务 SOP，或引用的任务 SOP 版本未找到，修正后才能导出 YAML。
            </div>
          )}
          {selectedSubsceneGroups.length === 0 ? (
            <div className="table-empty">当前客户需求还没有生产需求项</div>
          ) : (
            <div className="subscene-group-list">
              {selectedSubsceneGroups.map(([sceneName, rows]) => (
                <section className="subscene-group" key={sceneName}>
                  <div className="subscene-group-header">
                    <strong>{sceneName}</strong>
                    <span>{rows.length} 个生产需求项</span>
                  </div>
                  <DataTable
                    rows={rows}
                    columns={selectedSubsceneColumns}
                    rowKey={productionItemKey}
                    emptyText="当前场景下没有生产需求项"
                  />
                </section>
              ))}
            </div>
          )}
        </div>

        </section>
      </div>
      {taskSopPickerModal}
    </>
  );
}

function ScenePage({
  globalFields,
  materials,
  scenes,
  selectedSceneId,
  selectedSubsceneCode,
  selectedVersion,
  detailOpen,
  onSelectScene,
  onSelectSubscene,
  onSelectVersion,
  onDetailOpenChange,
  onSaveScene,
  onSaveSubscene,
  onDeleteSubsceneVersion,
  onConfirmSubscene,
  onExportSubscene,
  onExportSubscenePdf,
  onRun,
  attachmentStorageStatus,
  returnToRequirement,
  onReturnToRequirement,
  onClearReturnToRequirement,
  pageState,
  onLoadMoreScenes,
  taskPageState,
  onLoadMoreTaskSops,
  materialPageState,
  onLoadMoreMaterials,
}: {
  globalFields: GlobalField[];
  materials: Material[];
  scenes: Scene[];
  selectedSceneId: string;
  selectedSubsceneCode: string;
  selectedVersion: string;
  detailOpen: boolean;
  onSelectScene: (id: string) => void;
  onSelectSubscene: (code: string) => Promise<void>;
  onSelectVersion: (version: string) => void;
  onDetailOpenChange: (open: boolean) => void;
  onSaveScene: (scene: Scene) => Promise<void>;
  onSaveSubscene: (sceneId: string, code: string, version: VersionPatch<SubsceneVersion>) => Promise<boolean>;
  onDeleteSubsceneVersion: (sceneId: string, code: string, version: string) => Promise<void>;
  onConfirmSubscene: (sceneId: string, code: string, version: string) => Promise<void>;
  onExportSubscene: (subscene: Subscene, version: SubsceneVersion) => Promise<ExportResult | undefined>;
  onExportSubscenePdf: (subscene: Subscene, version: SubsceneVersion) => Promise<void>;
  onRun: <T>(action: () => Promise<T>, success: string) => Promise<T | undefined>;
  attachmentStorageStatus: AttachmentStorageStatus;
  returnToRequirement: RequirementReturnTarget | null;
  onReturnToRequirement: () => void;
  onClearReturnToRequirement: () => void;
  pageState?: ResourcePageState;
  onLoadMoreScenes: () => void;
  taskPageState?: ResourcePageState;
  onLoadMoreTaskSops: () => void;
  materialPageState?: ResourcePageState;
  onLoadMoreMaterials: () => void;
}) {
  const [sceneQuery, setSceneQuery] = useState('');
  const [subsceneQuery, setSubsceneQuery] = useState('');
  const [materialQuery, setMaterialQuery] = useState('');
  const [materialPickerOpen, setMaterialPickerOpen] = useState(false);
  const [sceneEditorOpen, setSceneEditorOpen] = useState(false);
  const [sceneDraft, setSceneDraft] = useState<Scene>(emptyScene());
  const [attachmentUpload, setAttachmentUpload] = useState<{ fileName: string; progress: number } | null>(null);
  const scene = scenes.find((item) => item.id === selectedSceneId) || scenes[0];
  const subscene = scene?.subscenes.find((item) => item.code === selectedSubsceneCode) || scene?.subscenes[0];
  const version = subscene
    ? subscene.versions.find((item) => item.version === selectedVersion) || latest(subscene.versions)
    : undefined;
  const checkpoint = revisionIsCheckpoint(version);
  const currentDraft = subscene ? activeEditableDraft(subscene.versions) : undefined;
  const canEditVersion = version?.status === 'draft' && !checkpoint;
  const canEditSubsceneTitle = Boolean(version && canEditVersion && (version.version === '0.0.1' || subscene?.versions.length === 1));
  const canEditDescription = Boolean(version && canEditVersion && version.status === 'draft');

  useEffect(() => {
    if (selectedVersion && subscene?.versions.some((item) => item.version === selectedVersion)) return;
    onSelectVersion('');
  }, [selectedSubsceneCode, selectedSceneId, selectedVersion, subscene]);

  const filteredScenes = scenes.filter((item) => matchesQuery(sceneQuery, [item.name, item.description]));
  const filteredSubscenes = scene?.subscenes.filter((item) =>
    matchesQuery(subsceneQuery, [
      item.code,
      item.name,
      latest(item.versions).title,
      latest(item.versions).status,
      latest(item.versions).version,
    ]),
  ) || [];
  const filteredMaterials = materials.filter((item) =>
    matchesQuery(materialQuery, [
      item.id,
      item.skuId,
      item.type,
      item.color,
      item.material,
      item.packageType,
      item.size,
      item.weight,
    ]),
  );

  if (!scene) {
    return (
      <section className="empty-state">
        <p>暂无场景数据，请先在数据文件中维护场景库。</p>
      </section>
    );
  }

  const subsceneColumns: Array<DataTableColumn<Subscene>> = [
    {
      key: 'name',
      title: '任务 SOP',
      width: 'minmax(150px, 1.5fr)',
      render: (item) => latest(item.versions).title || item.name,
    },
    {
      key: 'versions',
      title: '版本数',
      width: '68px',
      align: 'right',
      render: (item) => item.versions.length,
    },
    {
      key: 'latestVersion',
      title: '最新版本',
      width: '78px',
      render: (item) => `v${latest(item.versions).version}`,
    },
    {
      key: 'status',
      title: '状态',
      width: '78px',
      render: (item) => <StatusBadge status={latest(item.versions).status} />,
    },
    {
      key: 'materials',
      title: '物料',
      width: '66px',
      align: 'right',
      render: (item) => `${latest(item.versions).materials.length} 种`,
    },
    {
      key: 'updated',
      title: '最近更新',
      width: '104px',
      render: (item) => formatShortDate(latest(item.versions).updatedAt),
    },
    {
      key: 'action',
      title: '操作',
      width: '54px',
      render: (item) => (
        <button
          className="text-button"
          onClick={(event) => {
            event.stopPropagation();
            openSubsceneDetail(item.code);
          }}
        >
          查看
        </button>
      ),
    },
  ];

  const selectedMaterialColumns: Array<DataTableColumn<SubsceneVersion['materials'][number]>> = [
    {
      key: 'skuId',
      title: 'SKU',
      width: '170px',
      allowOverflow: true,
      render: (item) => {
        const material = materials.find((candidate) => candidate.id === item.materialId);
        const image = material?.images?.[0];
        return (
          <span className="sku-with-image">
            <strong className="table-link">{item.skuId}</strong>
            {image && <AttachmentThumbnail attachment={image} publicBaseUrl={attachmentStorageStatus.publicBaseUrl} />}
          </span>
        );
      },
    },
    { key: 'type', title: '物料名称', width: 'minmax(140px, 1.2fr)', render: (item) => item.type },
    {
      key: 'quantity',
      title: '数量',
      width: '150px',
      render: (item, index) =>
        version && subscene ? (
          <span className="inline-edit">
            <InlineNumberInput
              disabled={!canEditVersion}
              value={item.quantity.value || 0}
              onCommit={(quantityValue) => {
                if (!canEditVersion) return;
                const nextMaterials = version.materials.map((current, currentIndex) =>
                  currentIndex === index
                    ? { ...current, quantity: { ...current.quantity, mode: 'fixed' as const, value: quantityValue } }
                    : current,
                );
                void saveCurrentSubscene({ materials: nextMaterials });
              }}
            />
            {item.quantity.unit}
          </span>
        ) : (
          '-'
        ),
    },
    { key: 'color', title: '颜色', width: '110px', render: (item) => item.color || '-' },
    { key: 'material', title: '材质', width: '120px', render: (item) => item.material || '-' },
    { key: 'packageType', title: '包装类型', width: '120px', render: (item) => item.packageType || '-' },
    {
      key: 'size',
      title: '尺寸',
      width: '120px',
      render: (item) => materials.find((candidate) => candidate.id === item.materialId)?.size || '-',
    },
    {
      key: 'weight',
      title: '重量',
      width: '110px',
      render: (item) => materials.find((candidate) => candidate.id === item.materialId)?.weight || '-',
    },
    {
      key: 'action',
      title: '操作',
      width: '90px',
      render: (_item, index) =>
        version && subscene ? (
          <button
            className="text-button danger"
            disabled={!canEditVersion}
            onClick={(event) => {
              event.stopPropagation();
              if (!canEditVersion) return;
              const nextMaterials = version.materials.filter((_, currentIndex) => currentIndex !== index);
              void saveCurrentSubscene({ materials: nextMaterials });
            }}
          >
            移除
          </button>
        ) : (
          '-'
        ),
    },
  ];

  const materialLibraryColumns: Array<DataTableColumn<Material>> = [
    {
      key: 'skuId',
      title: 'SKU 编号',
      width: '130px',
      render: (item) => <strong className="table-link">{item.skuId}</strong>,
    },
    { key: 'type', title: '物料名称', width: 'minmax(140px, 1.2fr)', render: (item) => item.type || '-' },
    { key: 'color', title: '颜色', width: '110px', render: (item) => item.color || '-' },
    { key: 'material', title: '材质', width: '120px', render: (item) => item.material || '-' },
    { key: 'packageType', title: '包装类型', width: '120px', render: (item) => item.packageType || '-' },
    {
      key: 'status',
      title: '引用状态',
      width: '100px',
      render: (item) => {
        const selected = version?.materials.some((material) => material.materialId === item.id) ?? false;
        return (
          <span className={`material-reference-status ${selected ? 'selected' : 'available'}`}>
            {selected ? '已选择' : '可添加'}
          </span>
        );
      },
    },
  ];

  function addMaterial(material: Material) {
    if (!version || !subscene || !canEditVersion) return;
    if (version.materials.some((item) => item.materialId === material.id)) return;
    void saveCurrentSubscene({
      materials: [
        ...version.materials,
        {
          materialId: material.id,
          skuId: material.skuId,
          type: material.type,
          quantity: { mode: 'fixed', value: 1, unit: '件' },
          color: material.color,
          material: material.material,
          packageType: material.packageType,
        },
      ],
    });
  }

  async function saveCurrentSubscene(patch: Partial<SubsceneVersion>) {
    if (!subscene || !version) return false;
    const saved = await onSaveSubscene(scene.id, subscene.code, { ...patch, baseVersion: version.version });
    if (saved) onSelectVersion('');
    return saved;
  }

  async function createDraftFromCurrentSubsceneVersion() {
    if (currentDraft) {
      onSelectVersion(currentDraft.version);
      return;
    }
    await saveCurrentSubscene({});
  }

  async function deleteCurrentSubsceneDraft() {
    if (!subscene || !version || version.status !== 'draft') return;
    await onDeleteSubsceneVersion(scene.id, subscene.code, version.version);
    onSelectVersion('');
  }

  async function downloadCurrentSubsceneYaml() {
    if (!scene || !subscene || !version) return;
    const result = await onExportSubscene(subscene, version);
    if (!result) return;
    downloadTextFile(
      result.yaml,
      `${safeFileName(version.title || subscene.name)}-${version.version}.yaml`,
      'application/x-yaml;charset=utf-8',
    );
  }

  async function createSubscene() {
    const code = nextSubsceneCode(scenes);
    await onSaveSubscene(scene.id, code, emptySubsceneVersionDraft('新的任务 SOP'));
    onSelectVersion('');
    onDetailOpenChange(true);
  }

  function selectScene(id: string) {
    onSelectScene(id);
    onDetailOpenChange(false);
    onClearReturnToRequirement();
    setMaterialPickerOpen(false);
  }

  async function openSubsceneDetail(code: string) {
    await onSelectSubscene(code);
    onSelectVersion('');
    onClearReturnToRequirement();
    onDetailOpenChange(true);
  }

  function closeSubsceneDetail() {
    onDetailOpenChange(false);
    onClearReturnToRequirement();
    setMaterialPickerOpen(false);
  }

  function openSceneEditor() {
    setSceneDraft(emptyScene(`新的场景 ${scenes.length + 1}`));
    setSceneEditorOpen(true);
  }

  function openCurrentSceneEditor() {
    setSceneDraft(scene);
    setSceneEditorOpen(true);
  }

  async function saveSceneDraft() {
    const name = sceneDraft.name.trim();
    if (!name) return;
    await onSaveScene({ ...sceneDraft, name });
    setSceneEditorOpen(false);
  }

  async function uploadSubsceneAttachment(file: File): Promise<RequirementAttachment | undefined> {
    if (!scene || !subscene || !version || !canEditVersion) return undefined;
    const ownerName = resourceNameOf(subscene);
    if (!ownerName) throw new Error('任务 SOP 资源尚未创建');
    if (file.size > attachmentMaxSizeBytes) {
      window.alert('单个附件不能超过 100 MiB');
      return undefined;
    }
    try {
      setAttachmentUpload({ fileName: file.name, progress: 0 });
      const attachment = await uploadOwnerAttachment(
        'taskSops',
        ownerName,
        file,
        (progress) => setAttachmentUpload({ fileName: file.name, progress }),
      );
      const linked = await saveCurrentSubscene({ attachments: [...(version.attachments ?? []), attachment] });
      if (!linked) throw new Error('附件已上传，但任务 SOP 引用尚未保存；请先处理保存冲突');
      return attachment;
    } finally {
      setAttachmentUpload(null);
    }
  }

  const robotStateOptions = fieldOptions(globalFields, 'robot_state', [version?.robotState.initial || '', version?.robotState.target || '']).map((option) => ({
    value: option.value,
    label: option.label,
  }));
  const robotRandomOptions = fieldOptions(globalFields, 'robot_random_field');
  const robotInitialRandomRows = version
    ? robotInitialRandomizationRows(version.randomization, version.randomizationFrequency, robotRandomOptions)
    : [];
  function saveRobotInitialRandomRows(nextRows: RobotInitialRandomizationRow[]) {
    if (!version) return;
    void saveCurrentSubscene(robotInitialRandomizationPatch(version, nextRows, robotRandomOptions));
  }
  const robotInitialRandomColumns: Array<DataTableColumn<RobotInitialRandomizationRow>> = [
    {
      key: 'target',
      title: '对象',
      width: '160px',
      render: (row) => row.target,
    },
    {
      key: 'frequency',
      title: '每多少条变换',
      width: '140px',
      render: (row, index) => (
        <input
          type="number"
          min={1}
          value={row.changeIntervalRecords || 1}
          disabled={!canEditVersion}
          onChange={(event) => {
            const nextRows = robotInitialRandomRows.map((current, currentIndex) =>
              currentIndex === index ? { ...current, changeIntervalRecords: Number(event.target.value) || 1 } : current,
            );
            saveRobotInitialRandomRows(nextRows);
          }}
        />
      ),
    },
    {
      key: 'fields',
      title: '随机性要求',
      width: 'minmax(260px, 1.2fr)',
      allowOverflow: true,
      render: (row, index) => (
        <MultiSelectInput
          value={row.randomizedFields}
          options={robotRandomOptions}
          disabled={!canEditVersion}
          onChange={(randomizedFields) => {
            const nextRows = robotInitialRandomRows.map((current, currentIndex) =>
              currentIndex === index ? { ...current, randomizedFields } : current,
            );
            saveRobotInitialRandomRows(nextRows);
          }}
        />
      ),
    },
    {
      key: 'constraints',
      title: '限制条件',
      width: 'minmax(260px, 1fr)',
      render: (row, index) => (
        <LongTextDialogEditor
          title="机器人初始态随机性限制条件"
          value={row.constraints}
          disabled={!canEditVersion}
          placeholder="限制条件"
          onChange={(constraints) => {
            const nextRows = robotInitialRandomRows.map((current, currentIndex) =>
              currentIndex === index ? { ...current, constraints } : current,
            );
            saveRobotInitialRandomRows(nextRows);
          }}
        />
      ),
    },
    {
      key: 'action',
      title: '操作',
      width: '86px',
      render: (_row, index) => (
        <button
          className="text-button danger"
          disabled={!canEditVersion}
          onClick={() => {
            const nextRows = robotInitialRandomRows.filter((_, currentIndex) => currentIndex !== index);
            saveRobotInitialRandomRows(nextRows);
          }}
        >
          移除
        </button>
      ),
    },
  ];

  const materialPickerModal = materialPickerOpen && (
    <Modal title="从物料库添加物料" onClose={() => setMaterialPickerOpen(false)}>
      <SearchPanel
        title="物料库"
        description="点击物料行添加到当前任务 SOP"
        query={materialQuery}
        placeholder="搜索 SKU、物料名称、颜色、材质"
        count={filteredMaterials.length}
        onQueryChange={setMaterialQuery}
        actions={(
          <ResourceLoadMoreButton
            state={materialPageState}
            onLoadMore={onLoadMoreMaterials}
            label="加载更多物料"
          />
        )}
      />
      <DataTable
        rows={filteredMaterials}
        columns={materialLibraryColumns}
        rowKey={(material) => material.id}
        emptyText="没有匹配的物料"
        onRowClick={addMaterial}
      />
    </Modal>
  );

  if (detailOpen && subscene && version) {
    return (
      <>
        <div className="detail-page">
          <div className="detail-page-toolbar">
            <div className="button-row">
              {returnToRequirement && (
                <button className="ghost-button" onClick={onReturnToRequirement}>
                  返回需求页
                </button>
              )}
              <button className="ghost-button" onClick={closeSubsceneDetail}>
                返回任务 SOP 列表
              </button>
            </div>
            <span>{scene.name} / v{version.version}</span>
          </div>
          <section className="panel detail-panel">
            <div className="panel-header">
              <div>
                <h2>{version.title || subscene.name}</h2>
                <p className="version-time-meta">
                  v{version.version} · {statusText(version.status)}
                  <span>创建时间 {formatDateTime(version.createdAt || version.updatedAt)}</span>
                  <span>更新时间 {formatDateTime(version.updatedAt)}</span>
                </p>
              </div>
              <div className="button-row">
                <VersionMenu
                  value={version.version}
                  options={subscene.versions.map((item) => ({
                    value: item.version,
                    label: `v${item.version} · ${statusText(item.status)}`,
                  }))}
                  onChange={onSelectVersion}
                />
                <ExportMenu
                  items={[
                    {
                      label: '导出 PDF',
                      onSelect: () => onExportSubscenePdf(subscene, version),
                    },
                    {
                      label: '导出 YAML',
                      disabled: !revisionExportEligible(version),
                      title: !revisionExportEligible(version) ? '草稿版本只能导出 PDF' : undefined,
                      onSelect: downloadCurrentSubsceneYaml,
                    },
                  ]}
                />
                {version.status === 'confirmed' ? (
                  <button className="primary-button" onClick={() => void createDraftFromCurrentSubsceneVersion()}>
                    {currentDraft ? '进入当前草稿' : '编辑为草稿'}
                  </button>
                ) : checkpoint ? (
                  <span className="muted-text">导入草稿检查点（只读）</span>
                ) : (
                  <>
                    <button className="ghost-button danger" onClick={() => void deleteCurrentSubsceneDraft()}>
                      删除草稿
                    </button>
                    <button className="primary-button" onClick={() => void onConfirmSubscene(scene.id, subscene.code, version.version)}>
                      确认任务 SOP
                    </button>
                  </>
                )}
              </div>
            </div>
            {checkpoint
              ? <div className="notice info">这是迁移保留的旧草稿检查点，仅供追踪，不能编辑或确认，可以导出 PDF。</div>
              : version.status === 'confirmed' && (
                <div className="notice info">
                  {currentDraft
                    ? `当前已有草稿 v${currentDraft.version}，点击“进入当前草稿”继续编辑。`
                    : '当前任务 SOP 已确认，点击“编辑为草稿”会复制出新的草稿版本。'}
                </div>
              )}
            <CollapsibleSection title="基础信息" description="0.0.1 草稿可编辑名称；草稿版本可编辑描述">
              <div className="form-grid compact-fields">
                <Field
                  label="任务 SOP 名称"
                  value={version.title || ''}
                  disabled={!canEditSubsceneTitle}
                  onChange={(title) => void saveCurrentSubscene({ title })}
                />
              </div>
              <TextArea
                label="任务 SOP 描述"
                value={version.description || ''}
                disabled={!canEditDescription}
                onChange={(description) => void saveCurrentSubscene({ description })}
              />
              <AttachmentField
                title="任务 SOP 附件"
                hint="支持上传图片或视频，单个附件不超过 100 MiB"
                accept="image/*,video/*"
                attachments={version.attachments || []}
                disabled={!canEditVersion}
                storageStatus={attachmentStorageStatus}
                upload={attachmentUpload}
                onUpload={(file) => onRun(() => uploadSubsceneAttachment(file), '任务 SOP 附件已上传').then(() => undefined)}
                onDownload={(attachment) => onRun(() => downloadStoredAttachment(attachment), '附件已下载').then(() => undefined)}
                onDelete={async (attachmentId) => {
                  if (!scene || !subscene || !version) return;
                  const ownerName = resourceNameOf(subscene);
                  if (!ownerName) throw new Error('任务 SOP 资源尚未创建');
                  const nextAttachments = (version.attachments ?? [])
                    .filter((attachment) => attachment.id !== attachmentId);
                  await onRun(
                    async () => {
                      if (!await saveCurrentSubscene({ attachments: nextAttachments })) {
                        throw new Error('任务 SOP 引用尚未保存，附件未解除关联');
                      }
                      await resourceClient.unlinkAttachment('taskSops', ownerName, attachmentId);
                    },
                    '任务 SOP 附件已删除',
                  );
                }}
              />
            </CollapsibleSection>
            <CollapsibleSection title="机器人与随机性" description="机器人初始态、目标态和初始状态随机性">
              <div className="form-grid compact-fields">
                <SelectFieldInline
                  label="机器人初始态"
                  value={version.robotState.initial}
                  options={robotStateOptions}
                  disabled={!canEditVersion}
                  hideEmptyOption
                  onChange={(initial) => void saveCurrentSubscene({ robotState: { ...version.robotState, initial } })}
                />
                <SelectFieldInline
                  label="机器人目标态"
                  value={version.robotState.target}
                  options={robotStateOptions}
                  disabled={!canEditVersion}
                  onChange={(target) => void saveCurrentSubscene({ robotState: { ...version.robotState, target } })}
                />
              </div>
              <div className="embedded-table robot-randomization-table">
                <div className="embedded-table-header">
                  <div>
                    <h3>机器人初始态随机性</h3>
                    <p>按机器人初始状态配置随机字段与变换频率</p>
                  </div>
                  <button
                    className="primary-button"
                    disabled={!canEditVersion || robotInitialRandomRows.length > 0}
                    onClick={() =>
                      saveRobotInitialRandomRows([
                        {
                          target: '机器人初始态',
                          changeIntervalRecords: 1,
                          randomizedFields: [],
                          constraints: '',
                        },
                      ])
                    }
                  >
                    添加随机性
                  </button>
                </div>
                <DataTable
                  rows={robotInitialRandomRows}
                  columns={robotInitialRandomColumns}
                  rowKey={(_row, index) => `robot-initial-random-${index}`}
                  emptyText="暂无机器人初始态随机性"
                />
              </div>
            </CollapsibleSection>
            <CollapsibleSection title="物料相关" description="选择本任务 SOP 物料，并维护物料状态、状态规则和随机性要求">
              <div className="embedded-table">
                <div className="embedded-table-header">
                  <div>
                    <h3>已选物料</h3>
                    <p>点击添加从物料库选择，已选物料支持移除</p>
                  </div>
                  <div className="button-row">
                    <span className="result-count">{version.materials.length} 条</span>
                    <button className="primary-button" disabled={!canEditVersion} onClick={() => setMaterialPickerOpen(true)}>
                      添加物料
                    </button>
                  </div>
                </div>
                <DataTable
                  rows={version.materials}
                  columns={selectedMaterialColumns}
                  rowKey={(material, index) => `${material.skuId}-${index}`}
                  emptyText="当前任务 SOP 还没有选择物料"
                />
              </div>
              <SubsceneStateEditor
                globalFields={globalFields}
                version={version}
                materials={version.materials}
                readOnly={!canEditVersion}
                storageStatus={attachmentStorageStatus}
                upload={attachmentUpload}
                onUploadImage={(file) => onRun(() => uploadSubsceneAttachment(file), '示例图片已上传')}
                onSave={(patch) => {
                  if (!canEditVersion) return;
                  void saveCurrentSubscene(patch);
                }}
              />
            </CollapsibleSection>
            <CollapsibleSection title="采集步骤和说明" description="仅当前任务 SOP 使用的采集步骤、采集操作要求与禁止操作">
              <StepsTable
                title="采集步骤"
                description="左侧填写中文步骤和原子技能，右侧填写对应英文"
                emptyText="暂无采集步骤"
                steps={version.operation.steps}
                disabled={!canEditVersion}
                enableBulkImport
                onChange={(steps) => void saveCurrentSubscene({ operation: { ...version.operation, steps } })}
              />
              <StepRandomizationEditor
                title="采集步骤随机性"
                value={version.operation.stepRandomization}
                disabled={!canEditVersion}
                onChange={(stepRandomization) => void saveCurrentSubscene({ operation: { ...version.operation, stepRandomization } })}
              />
              <LocalTextItemEditor
                title="采集操作要求"
                description="仅在当前任务 SOP 中生效，可直接新建"
                items={version.operation.allowedOperations}
                disabled={!canEditVersion}
                onChange={(allowedOperations) => void saveCurrentSubscene({ operation: { ...version.operation, allowedOperations } })}
              />
              <LocalTextItemEditor
                title="采集禁止操作"
                description="仅在当前任务 SOP 中生效，可直接新建"
                items={version.operation.forbiddenOperations}
                disabled={!canEditVersion}
                onChange={(forbiddenOperations) => void saveCurrentSubscene({ operation: { ...version.operation, forbiddenOperations } })}
              />
              <LocalTextItemEditor
                title="不完美但可接受的采集操作"
                description="仅在当前任务 SOP 中生效，可直接新建"
                items={version.operation.acceptableOperations || []}
                disabled={!canEditVersion}
                onChange={(acceptableOperations) => void saveCurrentSubscene({ operation: { ...version.operation, acceptableOperations } })}
              />
            </CollapsibleSection>
            <CollapsibleSection title="标注步骤和说明" description="标注步骤，以及仅当前任务 SOP 生效的标注操作要求与禁止操作">
              <StepsTable
                title="标注步骤"
                description="左侧填写中文步骤和原子技能，右侧填写对应英文"
                emptyText="暂无标注步骤"
                steps={version.annotation.steps || []}
                disabled={!canEditVersion}
                enableBulkImport
                onChange={(steps) => void saveCurrentSubscene({ annotation: { ...version.annotation, steps } })}
              />
              <LocalTextItemEditor
                title="标注操作要求"
                description="仅在当前任务 SOP 中生效，可直接新建"
                items={version.annotation.allowedOperations || []}
                disabled={!canEditVersion}
                onChange={(allowedOperations) => void saveCurrentSubscene({ annotation: { ...version.annotation, allowedOperations } })}
              />
              <LocalTextItemEditor
                title="标注禁止操作"
                description="仅在当前任务 SOP 中生效，可直接新建"
                items={version.annotation.forbiddenOperations || []}
                disabled={!canEditVersion}
                onChange={(forbiddenOperations) => void saveCurrentSubscene({ annotation: { ...version.annotation, forbiddenOperations } })}
              />
            </CollapsibleSection>
          </section>
        </div>
        {materialPickerModal}
      </>
    );
  }

  return (
    <div className="scene-workbench">
      <aside className="scene-directory panel">
        <SearchPanel
          title="场景目录"
          description="按场景分组展示任务 SOP"
          query={sceneQuery}
          placeholder="搜索场景名称或描述"
          count={filteredScenes.length}
          onQueryChange={setSceneQuery}
          actions={
            <>
              {(pageState?.nextCursor || pageState?.error) && (
                <button className="ghost-button" disabled={pageState.loadingMore} onClick={onLoadMoreScenes}>
                  {pageState.loadingMore ? '正在加载…' : '加载更多'}
                </button>
              )}
              {(taskPageState?.nextCursor || taskPageState?.error) && (
                <button className="ghost-button" disabled={taskPageState.loadingMore} onClick={onLoadMoreTaskSops}>
                  {taskPageState.loadingMore ? '正在加载 SOP…' : '加载更多 SOP'}
                </button>
              )}
              <button className="primary-button" onClick={openSceneEditor}>
                新建场景
              </button>
            </>
          }
        />
        <div className="directory-list">
          {filteredScenes.map((item) => (
            <div className={`directory-group ${item.id === scene.id ? 'selected' : ''}`} key={item.id}>
              <button
                className="directory-row scene-row"
                onClick={() => selectScene(item.id)}
              >
                <strong>{item.name}</strong>
                <span>{item.subscenes.length} 个任务 SOP</span>
              </button>
              {item.id === scene.id && (
                <div className="directory-children">
                  {item.subscenes.map((child) => (
                    <button
                      className="directory-row subscene-row"
                      key={child.code}
                      onClick={() => openSubsceneDetail(child.code)}
                    >
                      <strong>{latest(child.versions).title || child.name}</strong>
                      <span>v{latest(child.versions).version} · {statusText(latest(child.versions).status)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

      <section className="scene-main">
        <section className="panel scene-summary">
          <div className="panel-header">
            <div>
              <h2>{scene.name}</h2>
              <p>{scene.description || '暂无场景描述'}</p>
            </div>
            <button className="ghost-button" onClick={openCurrentSceneEditor}>
              编辑场景
            </button>
          </div>
          <div className="info-grid">
            <InfoItem label="任务 SOP 数" value={scene.subscenes.length} />
            <InfoItem label="最近更新" value={sceneLatestUpdated(scene)} />
          </div>
        </section>

        <section className="panel table-panel">
          <SearchPanel
            title="任务 SOP 列表"
            description="点击任务 SOP 进入详情页"
            query={subsceneQuery}
            placeholder="搜索名称、状态或版本"
            count={filteredSubscenes.length}
            onQueryChange={setSubsceneQuery}
            actions={<button className="primary-button" onClick={() => void createSubscene()}>新建任务 SOP</button>}
          />
          <DataTable
            rows={filteredSubscenes}
            columns={subsceneColumns}
            rowKey={(item) => item.code}
            emptyText="没有匹配的任务 SOP"
            onRowClick={(item) => openSubsceneDetail(item.code)}
          />
        </section>
      </section>
      {materialPickerModal}
      {sceneEditorOpen && (
        <Modal title={sceneDraft.id ? '编辑场景' : '新建场景'} onClose={() => setSceneEditorOpen(false)}>
          <div className="modal-body">
            <div className="form-grid">
              <Field label="场景名称" value={sceneDraft.name} onChange={(name) => setSceneDraft({ ...sceneDraft, name })} />
            </div>
            <TextArea
              label="场景描述"
              value={sceneDraft.description}
              onChange={(description) => setSceneDraft({ ...sceneDraft, description })}
            />
            <div className="form-actions">
              <button className="primary-button" disabled={!sceneDraft.name.trim()} onClick={() => void saveSceneDraft()}>
                保存场景
              </button>
              <button className="ghost-button" onClick={() => setSceneEditorOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function GlobalFieldPage({
  globalFields,
  onSaveField,
  onOpenField,
  pageState,
  onLoadMore,
}: {
  globalFields: GlobalField[];
  onSaveField: (field: GlobalField) => Promise<GlobalField | undefined>;
  onOpenField: (field: GlobalField) => Promise<GlobalField>;
  pageState?: ResourcePageState;
  onLoadMore: () => void;
}) {
  const [fieldQuery, setFieldQuery] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<GlobalFieldGroup>('reference_object');
  const [statusFilter, setStatusFilter] = useState<GlobalFieldStatus | 'all'>('all');
  const [fieldDraft, setFieldDraft] = useState<GlobalField>(emptyGlobalField('reference_object'));
  const [editorOpen, setEditorOpen] = useState(false);
  const [savingField, setSavingField] = useState(false);
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(globalFieldCategories.map((category) => [category.id, category.groups.includes('reference_object')])),
  );

  const filteredFields = globalFields.filter(
    (field) =>
      field.group === selectedGroup &&
      (statusFilter === 'all' || field.status === statusFilter) &&
      matchesQuery(fieldQuery, [
        field.id,
        field.label,
        field.value,
        field.description,
        field.status === 'active' ? '启用' : '停用',
      ]),
  );

  const fieldColumns: Array<DataTableColumn<GlobalField>> = [
    {
      key: 'label',
      title: '字段名称',
      width: 'minmax(180px, 1.4fr)',
      render: (item) => <strong className="table-link">{item.label}</strong>,
    },
    {
      key: 'status',
      title: '状态',
      width: '92px',
      render: (item) => <StatusBadge status={item.status} />,
    },
    { key: 'updatedAt', title: '更新时间', width: '118px', render: (item) => formatShortDate(item.updatedAt) },
  ];
  const groupOptions = globalFieldCategories.flatMap((category) =>
    category.groups.map((group) => ({ value: group, label: `${category.label} / ${globalFieldGroupLabels[group]}` })),
  );

  function countFieldsInGroup(group: GlobalFieldGroup) {
    return globalFields.filter((field) => field.group === group).length;
  }

  function countFieldsInCategory(category: GlobalFieldCategory) {
    return category.groups.reduce((total, group) => total + countFieldsInGroup(group), 0);
  }

  function toggleCategory(categoryId: string) {
    setOpenCategories((current) => ({ ...current, [categoryId]: !current[categoryId] }));
  }

  async function saveFieldDraft(patch: Partial<GlobalField> = {}): Promise<boolean> {
    const label = (patch.label ?? fieldDraft.label).trim();
    const next = {
      ...fieldDraft,
      group: fieldDraft.group || selectedGroup,
      ...patch,
      label,
      value: label,
    };
    if (!next.label) return false;
    setSavingField(true);
    try {
      const saved = await onSaveField(next);
      if (!saved) return false;
      setFieldDraft(emptyGlobalField(next.group));
      return true;
    } finally {
      setSavingField(false);
    }
  }

  function selectGroup(group: GlobalFieldGroup) {
    const category = findGlobalFieldCategory(group);
    if (category) {
      setOpenCategories((current) => ({ ...current, [category.id]: true }));
    }
    setSelectedGroup(group);
    setFieldDraft(emptyGlobalField(group));
    setEditorOpen(false);
  }

  async function openFieldEditor(field: GlobalField) {
    setFieldDraft(field);
    setEditorOpen(true);
    try {
      const resolved = await onOpenField(field);
      setFieldDraft(resolved);
      setSelectedGroup(resolved.group);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  function openNewFieldEditor() {
    setFieldDraft(emptyGlobalField(selectedGroup));
    setEditorOpen(true);
  }

  async function saveFieldAndClose(patch: Partial<GlobalField> = {}) {
    if (await saveFieldDraft(patch)) {
      setEditorOpen(false);
    }
  }

  return (
    <div className="global-field-workbench">
      <aside className="field-groups panel">
        <div className="panel-header">
          <div>
            <h2>字段分组</h2>
            <p>全局词表分组</p>
          </div>
        </div>
        <div className="field-group-list">
          {globalFieldCategories.map((category) => {
            const isOpen = openCategories[category.id] ?? false;
            const selectedInCategory = category.groups.includes(selectedGroup);
            const total = countFieldsInCategory(category);
            return (
              <div className={`field-category ${selectedInCategory ? 'contains-selected' : ''}`} key={category.id}>
                <button
                  type="button"
                  className="field-category-row"
                  aria-expanded={isOpen}
                  onClick={() => toggleCategory(category.id)}
                >
                  <span>
                    <strong>{category.label}</strong>
                    <small>{category.description}</small>
                  </span>
                  <span className="field-category-meta">
                    <span>{total}</span>
                    <b>{isOpen ? '收起' : '展开'}</b>
                  </span>
                </button>
                {isOpen && (
                  <div className="field-category-groups">
                    {category.groups.map((group) => (
                      <button
                        type="button"
                        className={`field-group-row ${selectedGroup === group ? 'selected' : ''}`}
                        key={group}
                        onClick={() => selectGroup(group)}
                      >
                        <strong>{globalFieldGroupLabels[group]}</strong>
                        <span>{countFieldsInGroup(group)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <section className="panel table-panel global-field-values">
        <SearchPanel
          title={`${globalFieldGroupLabels[selectedGroup]}字段`}
          description="停用后不再出现在新的下拉选择中，历史数据仍保留"
          query={fieldQuery}
          placeholder="搜索字段名称或说明"
          count={filteredFields.length}
          onQueryChange={setFieldQuery}
          actions={
            <>
              <label className="compact-filter">
                <span>状态</span>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as GlobalFieldStatus | 'all')}>
                  <option value="all">全部</option>
                  <option value="active">启用</option>
                  <option value="inactive">停用</option>
                </select>
              </label>
              <button className="primary-button" onClick={openNewFieldEditor}>
                新建字段
              </button>
              {(pageState?.nextCursor || pageState?.error) && (
                <button className="ghost-button" disabled={pageState.loadingMore} onClick={onLoadMore}>
                  {pageState.loadingMore ? '正在加载…' : '加载更多'}
                </button>
              )}
            </>
          }
        />
        <DataTable
          rows={filteredFields}
          columns={fieldColumns}
          rowKey={(item) => item.id}
          selectedKey={fieldDraft.id}
          emptyText="当前分组没有匹配字段"
          onRowClick={(field) => void openFieldEditor(field)}
        />
      </section>
      {editorOpen && (
        <Modal title="字段详情" onClose={() => setEditorOpen(false)}>
          <div className="modal-body">
            <div className="form-grid">
              <SelectField
                label="字段分组"
                value={fieldDraft.group}
                options={groupOptions}
                onChange={(group) => {
                  const nextGroup = group as GlobalFieldGroup;
                  selectGroup(nextGroup);
                  setFieldDraft({ ...fieldDraft, group: nextGroup });
                  setEditorOpen(true);
                }}
              />
              <SelectField
                label="状态"
                value={fieldDraft.status}
                options={[
                  { value: 'active', label: '启用' },
                  { value: 'inactive', label: '停用' },
                ]}
                onChange={(status) => setFieldDraft({ ...fieldDraft, status: status as GlobalFieldStatus })}
              />
              <Field label="字段名称" value={fieldDraft.label} onChange={(label) => setFieldDraft({ ...fieldDraft, label })} />
              <Field
                label="说明"
                value={fieldDraft.description || ''}
                onChange={(description) => setFieldDraft({ ...fieldDraft, description })}
              />
            </div>
            <div className="form-actions">
              <button className="primary-button" disabled={savingField} onClick={() => void saveFieldAndClose()}>
                {savingField ? '保存中…' : '保存字段'}
              </button>
              {fieldDraft.id && (
                <button
                  className="ghost-button"
                  disabled={savingField}
                  onClick={() => void saveFieldAndClose({ status: fieldDraft.status === 'active' ? 'inactive' : 'active' })}
                >
                  {fieldDraft.status === 'active' ? '停用字段' : '启用字段'}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function MultiSelectField({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string[];
  options: Option[];
  disabled?: boolean;
  onChange: (value: string[]) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <MultiSelectInput value={value} options={options} disabled={disabled} onChange={onChange} />
    </label>
  );
}

function OperationRequirementGroup({
  title,
  value,
  options,
  readOnly,
  onChange,
}: {
  title: string;
  value: string[];
  options: Option[];
  readOnly: boolean;
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(!readOnly);
  const [query, setQuery] = useState('');
  const selectedOptions = value.map((item) => options.find((option) => option.value === item) || { value: item, label: item });
  const allOptions = uniqueOptions([...options, ...selectedOptions]);
  const visibleOptions = readOnly ? selectedOptions : allOptions;
  const filteredOptions = visibleOptions.filter((option) => matchesQuery(query, [
    option.label,
    option.value,
    option.category,
    option.description,
  ]));
  const summary = selectedOptions.length ? selectedOptions.map((option) => option.label).join('、') : '未选择';

  useEffect(() => {
    setOpen(!readOnly);
  }, [readOnly]);

  function toggleValue(target: string) {
    if (readOnly) return;
    if (value.includes(target)) {
      onChange(value.filter((item) => item !== target));
      return;
    }
    onChange([...value, target]);
  }

  function selectFilteredOptions() {
    if (readOnly) return;
    onChange(Array.from(new Set([...value, ...filteredOptions.map((option) => option.value)])));
  }

  function clearFilteredOptions() {
    if (readOnly) return;
    const filteredValues = new Set(filteredOptions.map((option) => option.value));
    onChange(value.filter((item) => !filteredValues.has(item)));
  }

  function optionDescription(option: Option): string {
    const description = option.description?.trim() || '';
    return description && description !== option.label ? description : '';
  }

  return (
    <div className={`operation-requirement-group ${open ? 'open' : ''}`} role="group" aria-label={title}>
      <button type="button" className="operation-requirement-summary" onClick={() => setOpen((current) => !current)}>
        <span>
          <strong>{title}</strong>
          <small>{readOnly ? summary : `${selectedOptions.length} / ${allOptions.length} 已选`}</small>
        </span>
        <b>{open ? '收起' : '展开'}</b>
      </button>
      {open && (
        <div className="operation-requirement-content">
          {!readOnly && (
            <div className="operation-requirement-toolbar">
              <input
                type="search"
                value={query}
                aria-label={`搜索${title}`}
                placeholder="搜索关键词"
                onChange={(event) => setQuery(event.target.value)}
              />
              <span className="operation-requirement-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={filteredOptions.length === 0 || filteredOptions.every((option) => value.includes(option.value))}
                  onClick={selectFilteredOptions}
                >
                  {query.trim() ? '全选结果' : '全选'}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={!filteredOptions.some((option) => value.includes(option.value))}
                  onClick={clearFilteredOptions}
                >
                  {query.trim() ? '取消结果' : '取消全选'}
                </button>
              </span>
            </div>
          )}
          <div className="operation-requirement-list">
          {filteredOptions.length === 0 ? (
            <div className="operation-requirement-empty">{readOnly ? '暂无已选条目' : '暂无可选条目'}</div>
          ) : (
            filteredOptions.map((option) =>
              readOnly ? (
                <div className="operation-requirement-readonly-item" key={`${title}-${option.value}`}>
                  <span>{option.category ? `${option.category} / ${option.label}` : option.label}</span>
                  {optionDescription(option) && <small>{optionDescription(option)}</small>}
                </div>
              ) : (
                <label className="operation-requirement-option" key={`${title}-${option.value}`}>
                  <input type="checkbox" checked={value.includes(option.value)} onChange={() => toggleValue(option.value)} />
                  <span>
                    {option.category ? `${option.category} / ${option.label}` : option.label}
                    {optionDescription(option) && <small>{optionDescription(option)}</small>}
                  </span>
                </label>
              ),
            )
          )}
          </div>
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({
  title,
  description,
  defaultOpen = true,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="collapsible-section" open={defaultOpen}>
      <summary>
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        <span>展开/收起</span>
      </summary>
      <div className="collapsible-content">{children}</div>
    </details>
  );
}

function SelectFieldInline({
  label,
  value,
  options,
  disabled = false,
  hideEmptyOption = false,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  hideEmptyOption?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        className={value ? '' : 'placeholder-value'}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="" hidden={hideEmptyOption}>请选择</option>
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberedTextArea({
  value,
  disabled,
  placeholder,
  minRows = 1,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  placeholder?: string;
  minRows?: number;
  onChange: (value: string) => void;
}) {
  const lineCount = Math.max(minRows, value.split('\n').length || 1);

  return (
    <div className="numbered-textarea">
      <div className="line-number-gutter" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      <textarea
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function splitStepBulkLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').split('\n');
}

function BulkStepsModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (steps: OperationStep[]) => void;
}) {
  const [draft, setDraft] = useState({
    description: '',
    atomicSkill: '',
    englishDescription: '',
    englishAtomicSkill: '',
  });
  const columns = {
    description: splitStepBulkLines(draft.description),
    atomicSkill: splitStepBulkLines(draft.atomicSkill),
    englishDescription: splitStepBulkLines(draft.englishDescription),
    englishAtomicSkill: splitStepBulkLines(draft.englishAtomicSkill),
  };
  const maxRows = Math.max(
    columns.description.length,
    columns.atomicSkill.length,
    columns.englishDescription.length,
    columns.englishAtomicSkill.length,
  );
  const importedSteps = Array.from({ length: maxRows }, (_, index) => ({
    order: index + 1,
    description: columns.description[index]?.trim() || '',
    atomicSkill: columns.atomicSkill[index]?.trim() || '',
    englishDescription: columns.englishDescription[index]?.trim() || '',
    englishAtomicSkill: columns.englishAtomicSkill[index]?.trim() || '',
  })).filter((step) => step.description || step.atomicSkill || step.englishDescription || step.englishAtomicSkill);

  return (
    <Modal title="批量输入步骤" panelClassName="step-bulk-panel" onClose={onClose}>
      <div className="modal-body step-bulk-modal">
        <p className="helper-text">每一行会按行号合并成同一个步骤；可以只填写其中几列。</p>
        <div className="step-bulk-grid">
          <label>
            <span>中文步骤</span>
            <NumberedTextArea
              value={draft.description}
              minRows={8}
              placeholder="一行一个中文步骤"
              onChange={(description) => setDraft((current) => ({ ...current, description }))}
            />
          </label>
          <label>
            <span>中文原子技能</span>
            <NumberedTextArea
              value={draft.atomicSkill}
              minRows={8}
              placeholder="一行一个原子技能"
              onChange={(atomicSkill) => setDraft((current) => ({ ...current, atomicSkill }))}
            />
          </label>
          <label>
            <span>English Step</span>
            <NumberedTextArea
              value={draft.englishDescription}
              minRows={8}
              placeholder="One English step per line"
              onChange={(englishDescription) => setDraft((current) => ({ ...current, englishDescription }))}
            />
          </label>
          <label>
            <span>English Atomic Skill</span>
            <NumberedTextArea
              value={draft.englishAtomicSkill}
              minRows={8}
              placeholder="One atomic skill per line"
              onChange={(englishAtomicSkill) => setDraft((current) => ({ ...current, englishAtomicSkill }))}
            />
          </label>
        </div>
        <div className="form-actions">
          <button className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={importedSteps.length === 0} onClick={() => onConfirm(importedSteps)}>
            确认导入
          </button>
        </div>
      </div>
    </Modal>
  );
}

function StepsTable({
  title,
  description,
  emptyText,
  steps,
  disabled,
  enableBulkImport = false,
  onChange,
}: {
  title: string;
  description: string;
  emptyText: string;
  steps: OperationStep[];
  disabled: boolean;
  enableBulkImport?: boolean;
  onChange: (steps: OperationStep[]) => void;
}) {
  const stepsSignature = JSON.stringify(steps);
  const [draftSteps, setDraftSteps] = useState<OperationStep[]>(() => normalize(steps));
  const [bulkOpen, setBulkOpen] = useState(false);

  useEffect(() => {
    setDraftSteps(normalize(steps));
  }, [stepsSignature]);

  function normalize(nextSteps: OperationStep[]) {
    return nextSteps.map((step, index) => ({ ...step, order: index + 1 }));
  }

  function commitSteps(nextSteps = draftSteps) {
    const normalizedSteps = normalize(nextSteps);
    if (JSON.stringify(normalizedSteps) !== JSON.stringify(normalize(steps))) {
      onChange(normalizedSteps);
    }
  }

  function updateStepDraft(index: number, patch: Partial<OperationStep>) {
    setDraftSteps((currentSteps) =>
      normalize(
        currentSteps.map((step, currentIndex) =>
          currentIndex === index
            ? {
                ...step,
                ...patch,
              }
            : step,
        ),
      ),
    );
  }

  function addStep() {
    setDraftSteps((currentSteps) =>
      normalize([
        ...currentSteps,
        { order: currentSteps.length + 1, description: '', atomicSkill: '', englishDescription: '', englishAtomicSkill: '' },
      ]),
    );
  }

  function removeStep(index: number) {
    const nextSteps = normalize(draftSteps.filter((_, currentIndex) => currentIndex !== index));
    setDraftSteps(nextSteps);
    onChange(nextSteps);
  }

  function importSteps(importedSteps: OperationStep[]) {
    const nextSteps = normalize([...draftSteps, ...importedSteps]);
    setDraftSteps(nextSteps);
    onChange(nextSteps);
    setBulkOpen(false);
  }

  return (
    <>
      <div className="embedded-table annotation-steps-table">
        <div className="embedded-table-header">
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
          <div className="button-row">
            {enableBulkImport && (
              <button className="ghost-button" disabled={disabled} onClick={() => setBulkOpen(true)}>
                批量输入步骤
              </button>
            )}
            <button className="primary-button" disabled={disabled} onClick={addStep}>
              新增步骤
            </button>
          </div>
        </div>
        <div className="annotation-steps-grid">
          <div className="annotation-steps-head">序号</div>
          <div className="annotation-steps-head">中文步骤</div>
          <div className="annotation-steps-head">中文原子技能</div>
          <div className="annotation-steps-head">English Step</div>
          <div className="annotation-steps-head">English Atomic Skill</div>
          <div className="annotation-steps-head">操作</div>
          {draftSteps.length === 0 ? (
            <div className="annotation-steps-empty">{emptyText}</div>
          ) : (
            draftSteps.map((step, index) => (
              <div className="annotation-steps-row" key={`${title}-${index}`}>
                <div className="annotation-step-order">{index + 1}</div>
                <textarea
                  value={step.description || ''}
                  disabled={disabled}
                  placeholder="中文步骤"
                  onBlur={() => commitSteps()}
                  onChange={(event) => updateStepDraft(index, { description: event.target.value })}
                />
                <textarea
                  value={step.atomicSkill || ''}
                  disabled={disabled}
                  placeholder="中文原子技能"
                  onBlur={() => commitSteps()}
                  onChange={(event) => updateStepDraft(index, { atomicSkill: event.target.value })}
                />
                <textarea
                  value={step.englishDescription || ''}
                  disabled={disabled}
                  placeholder="English step"
                  onBlur={() => commitSteps()}
                  onChange={(event) => updateStepDraft(index, { englishDescription: event.target.value })}
                />
                <textarea
                  value={step.englishAtomicSkill || ''}
                  disabled={disabled}
                  placeholder="English atomic skill"
                  onBlur={() => commitSteps()}
                  onChange={(event) => updateStepDraft(index, { englishAtomicSkill: event.target.value })}
                />
                <button className="text-button danger" disabled={disabled} onClick={() => removeStep(index)}>
                  移除
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      {bulkOpen && <BulkStepsModal onClose={() => setBulkOpen(false)} onConfirm={importSteps} />}
    </>
  );
}

function StepRandomizationEditor({
  title,
  value,
  disabled,
  onChange,
}: {
  title: string;
  value?: { enabled: boolean; startOrder: number; endOrder: number };
  disabled: boolean;
  onChange: (value: { enabled: boolean; startOrder: number; endOrder: number }) => void;
}) {
  const current = value || { enabled: false, startOrder: 1, endOrder: 1 };
  return (
    <div className="form-grid compact-fields">
      <label className="field checkbox-field">
        <span>{title}</span>
        <label>
          <input
            type="checkbox"
            checked={current.enabled}
            disabled={disabled}
            onChange={(event) => onChange({ ...current, enabled: event.target.checked })}
          />
          启用
        </label>
      </label>
      <label className="field">
        <span>第几步到第几步可随机</span>
        <span className="range-edit">
          <input
            type="number"
            min={1}
            value={current.startOrder}
            disabled={disabled}
            onChange={(event) => onChange({ ...current, startOrder: Number(event.target.value) || 1 })}
          />
          <input
            type="number"
            min={1}
            value={current.endOrder}
            disabled={disabled}
            onChange={(event) => onChange({ ...current, endOrder: Number(event.target.value) || 1 })}
          />
        </span>
      </label>
    </div>
  );
}

function LongTextDialogEditor({
  title,
  value,
  disabled,
  placeholder = '填写内容',
  onChange,
}: {
  title: string;
  value: string;
  disabled: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!open) setDraft(value);
  }, [open, value]);

  function save() {
    onChange(draft);
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        className={`summary-edit-button ${value ? '' : 'placeholder-value'}`}
        aria-label={`编辑${title}`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span>{value || placeholder}</span>
      </button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          <div className="modal-body">
            <textarea
              className="long-text-editor"
              value={draft}
              placeholder={placeholder}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="form-actions">
              <button className="primary-button" onClick={save}>
                保存
              </button>
              <button className="ghost-button" onClick={() => setOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function LocalTextItemEditor({
  title,
  description,
  items,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  items: SubsceneVersion['operation']['allowedOperations'];
  disabled: boolean;
  onChange: (items: SubsceneVersion['operation']['allowedOperations']) => void;
}) {
  const itemsSignature = JSON.stringify(items);
  const [draftItems, setDraftItems] = useState<TextItem[]>(items);

  useEffect(() => {
    setDraftItems(items);
  }, [itemsSignature]);

  function commitItems(nextItems = draftItems) {
    if (JSON.stringify(nextItems) !== JSON.stringify(items)) {
      onChange(nextItems);
    }
  }

  function updateItemDraft(index: number, description: string) {
    setDraftItems((currentItems) =>
      currentItems.map((current, currentIndex) => (currentIndex === index ? { ...current, description } : current)),
    );
  }

  function addItem() {
    setDraftItems((currentItems) => [...currentItems, { description: '' }]);
  }

  function removeItem(index: number) {
    const nextItems = draftItems.filter((_, currentIndex) => currentIndex !== index);
    setDraftItems(nextItems);
    onChange(nextItems);
  }

  return (
    <div className="embedded-table">
      <div className="embedded-table-header">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <button
          className="primary-button"
          disabled={disabled}
          onClick={addItem}
        >
          新增
        </button>
      </div>
      <div className="local-item-list">
        {draftItems.length === 0 && <div className="table-empty">暂无内容</div>}
        {draftItems.map((item, index) => (
          <div className="local-item-row" key={`${title}-${index}`}>
            <input
              value={item.description}
              disabled={disabled}
              placeholder="说明"
              onBlur={() => commitItems()}
              onChange={(event) => updateItemDraft(index, event.target.value)}
            />
            <button className="text-button danger" disabled={disabled} onClick={() => removeItem(index)}>
              移除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function CustomerPage({ customers, onSave, onOpen, pageState, onLoadMore }: {
  customers: Customer[];
  onSave: (customer: Customer) => Promise<Customer | undefined>;
  onOpen: (customer: Customer) => Promise<Customer>;
  pageState?: ResourcePageState;
  onLoadMore: () => void;
}) {
  const [draft, setDraft] = useState<Customer>(customers[0] || emptyCustomer());
  const newDraft = useRef(false);
  useEffect(() => {
    setDraft((current) => reconcileMasterDraftFromItems(current, customers, newDraft.current, emptyCustomer()));
  }, [customers]);
  const columns: Array<DataTableColumn<Customer>> = [
    {
      key: 'name',
      title: '客户名称',
      width: 'minmax(180px, 1.4fr)',
      render: (item) => <strong className="table-link">{item.name || '未命名客户'}</strong>,
    },
    { key: 'contact', title: '联系人', width: '140px', render: (item) => item.contact.name || '-' },
    { key: 'phone', title: '电话', width: '150px', render: (item) => item.contact.phone || '-' },
    { key: 'email', title: '邮箱', width: 'minmax(180px, 1.3fr)', render: (item) => item.contact.email || '-' },
    { key: 'notes', title: '备注', width: 'minmax(220px, 1.6fr)', render: (item) => item.notes || '-' },
  ];
  return (
    <MasterDataPage
      title="客户"
      description="客户主数据供客户需求引用"
      items={customers}
      columns={columns}
      getTitle={(item) => item.name}
      getSearchText={(item) => `${item.name} ${item.contact.name} ${item.contact.phone} ${item.contact.email} ${item.notes || ''}`}
      selectedId={draft.id}
      onSelect={(item) => {
        newDraft.current = false;
        setDraft(item);
      }}
      onResolve={onOpen}
      onNew={() => {
        newDraft.current = true;
        setDraft(emptyCustomer());
      }}
      hasMore={Boolean(pageState?.nextCursor)}
      loadingMore={pageState?.loadingMore}
      loadMoreError={pageState?.error}
      onLoadMore={onLoadMore}
    >
      {(closeEditor) => (
        <>
          <Field label="客户名称" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
          <Field label="联系人" value={draft.contact.name} onChange={(name) => setDraft({ ...draft, contact: { ...draft.contact, name } })} />
          <Field label="电话" value={draft.contact.phone} onChange={(phone) => setDraft({ ...draft, contact: { ...draft.contact, phone } })} />
          <Field label="邮箱" value={draft.contact.email} onChange={(email) => setDraft({ ...draft, contact: { ...draft.contact, email } })} />
          <TextArea label="备注" value={draft.notes || ''} onChange={(notes) => setDraft({ ...draft, notes })} />
          <button className="primary-button" onClick={() => void onSave(draft).then((saved) => {
            if (!saved) return;
            newDraft.current = false;
            setDraft(saved);
            closeEditor();
          })}>
            保存客户
          </button>
        </>
      )}
    </MasterDataPage>
  );
}

function SubsceneStateEditor({
  globalFields,
  version,
  materials,
  readOnly,
  storageStatus,
  upload,
  onUploadImage,
  onSave,
}: {
  globalFields: GlobalField[];
  version: SubsceneVersion;
  materials: SubsceneVersion['materials'];
  readOnly: boolean;
  storageStatus: AttachmentStorageStatus;
  upload: { fileName: string; progress: number } | null;
  onUploadImage: (file: File) => Promise<RequirementAttachment | undefined>;
  onSave: (patch: Partial<SubsceneVersion>) => void;
}) {
  const rows = initialStateRows(version.objectStates.initial);
  const targetRows = targetStateRows(version.objectStates.target);
  const materialInitialRandomRows = materialInitialRandomizationRows(version.randomization);
  const materialOptions = materials.map((material) => material.type);
  const materialRandomOptions = fieldOptions(globalFields, 'material_random_field');
  const [expandedInitialRows, setExpandedInitialRows] = useState<Record<number, boolean>>({});
  const [expandedTargetRows, setExpandedTargetRows] = useState<Record<number, boolean>>({});
  const [expandedRandomRows, setExpandedRandomRows] = useState<Record<number, boolean>>({});

  function valuesForGroup(group: GlobalFieldGroup, currentValues: string[] = []): string[] {
    return fieldOptions(globalFields, group, currentValues).map((option) => option.value);
  }

  function saveRows(nextRows: InitialLocationRow[]) {
    if (readOnly) return;
    onSave({ objectStates: { ...version.objectStates, initial: initialStatesFromRows(nextRows) } });
  }

  function updateRow(index: number, patch: Partial<InitialLocationRow>) {
    saveRows(rows.map((row, currentIndex) => (currentIndex === index ? { ...row, ...patch } : row)));
  }

  function saveTargetRows(nextRows: TargetStateRow[]) {
    if (readOnly) return;
    onSave({ objectStates: { ...version.objectStates, target: targetStatesFromRows(nextRows) } });
  }

  function updateTargetRow(index: number, patch: Partial<TargetStateRow>) {
    saveTargetRows(targetRows.map((row, currentIndex) => (currentIndex === index ? { ...row, ...patch } : row)));
  }

  function saveMaterialInitialRandomRows(nextRows: MaterialInitialRandomizationRow[]) {
    if (readOnly) return;
    onSave({
      randomization: {
        ...version.randomization,
        materialInitialState: { rules: materialInitialRandomizationFromRows(nextRows) },
      },
    });
  }

  function updateMaterialInitialRandomRow(index: number, patch: Partial<MaterialInitialRandomizationRow>) {
    saveMaterialInitialRandomRows(materialInitialRandomRows.map((row, currentIndex) => (currentIndex === index ? { ...row, ...patch } : row)));
  }

  async function bindUploadedImage(target: StateImageUploadTarget, file: File) {
    if (!file.type.startsWith('image/')) {
      window.alert('这里只能上传图片');
      return;
    }
    const attachment = await onUploadImage(file);
    if (!attachment) return;
    if (target.kind === 'initial') {
      const row = rows[target.index];
      updateRow(target.index, { exampleImageAttachmentIds: [...row.exampleImageAttachmentIds, attachment.id] });
    }
    if (target.kind === 'target') {
      const row = targetRows[target.index];
      updateTargetRow(target.index, { exampleImageAttachmentIds: [...row.exampleImageAttachmentIds, attachment.id] });
    }
    if (target.kind === 'randomization') {
      const row = materialInitialRandomRows[target.index];
      updateMaterialInitialRandomRow(target.index, { exampleImageAttachmentIds: [...row.exampleImageAttachmentIds, attachment.id] });
    }
  }

  function unbindImage(target: StateImageUploadTarget, attachmentId: string) {
    if (target.kind === 'initial') {
      const row = rows[target.index];
      updateRow(target.index, { exampleImageAttachmentIds: row.exampleImageAttachmentIds.filter((id) => id !== attachmentId) });
    }
    if (target.kind === 'target') {
      const row = targetRows[target.index];
      updateTargetRow(target.index, { exampleImageAttachmentIds: row.exampleImageAttachmentIds.filter((id) => id !== attachmentId) });
    }
    if (target.kind === 'randomization') {
      const row = materialInitialRandomRows[target.index];
      updateMaterialInitialRandomRow(target.index, { exampleImageAttachmentIds: row.exampleImageAttachmentIds.filter((id) => id !== attachmentId) });
    }
  }

  function stateDetailEditor<T extends InitialLocationRow>({
    row,
    index,
    update,
  }: {
    row: T;
    index: number;
    update: (index: number, patch: Partial<T>) => void;
  }) {
    return (
      <div className="state-card-detail">
        <section>
          <h4>位置关系</h4>
          <div className="row-detail-grid">
            <label>
              <span>放在/靠近什么</span>
              <SingleEnumSelect
                value={row.primaryReferences}
                options={valuesForGroup('reference_object', row.primaryReferences)}
                placeholder="选择参照物"
                disabled={readOnly}
                allowCustom
                onChange={(primaryReferences) => update(index, { primaryReferences } as Partial<T>)}
              />
            </label>
            <label>
              <span>在它的哪里</span>
              <SingleEnumSelect
                value={row.primaryRelativePositions}
                options={valuesForGroup('relative_position', row.primaryRelativePositions)}
                placeholder="选择相对位置"
                disabled={readOnly}
                allowCustom
                onChange={(primaryRelativePositions) => update(index, { primaryRelativePositions } as Partial<T>)}
              />
            </label>
            <label>
              <span>接触哪个面</span>
              <SingleEnumSelect
                value={row.supportSurfaces}
                options={valuesForGroup('support_surface', row.supportSurfaces)}
                placeholder="选择支撑面"
                disabled={readOnly}
                allowCustom
                onChange={(supportSurfaces) => update(index, { supportSurfaces } as Partial<T>)}
              />
            </label>
          </div>
        </section>
        <section>
          <h4>更具体的位置</h4>
          <div className="row-detail-grid">
            <label>
              <span>区域</span>
              <MultiEnumInput
                value={row.regions}
                options={valuesForGroup('region', row.regions)}
                placeholder="选择区域"
                disabled={readOnly}
                allowCustom
                onChange={(regions) => update(index, { regions } as Partial<T>)}
              />
            </label>
            <label>
              <span>更靠近什么</span>
              <SingleEnumSelect
                value={row.secondaryReferences}
                options={valuesForGroup('reference_object', row.secondaryReferences)}
                placeholder="选择参照物"
                disabled={readOnly}
                allowCustom
                onChange={(secondaryReferences) => update(index, { secondaryReferences } as Partial<T>)}
              />
            </label>
            <label>
              <span>在它的哪里</span>
              <SingleEnumSelect
                value={row.secondaryRelativePositions}
                options={valuesForGroup('relative_position', row.secondaryRelativePositions)}
                placeholder="选择相对位置"
                disabled={readOnly}
                allowCustom
                onChange={(secondaryRelativePositions) => update(index, { secondaryRelativePositions } as Partial<T>)}
              />
            </label>
          </div>
        </section>
        <section>
          <h4>怎么放</h4>
          <div className="row-detail-grid">
            <label>
              <span>姿态</span>
              <MultiEnumInput
                value={row.poses}
                options={valuesForGroup('pose', row.poses)}
                placeholder="选择姿态"
                disabled={readOnly}
                allowCustom
                onChange={(poses) => update(index, { poses } as Partial<T>)}
              />
            </label>
            <label>
              <span>形态</span>
              <MultiEnumInput
                value={row.forms}
                options={valuesForGroup('form', row.forms)}
                placeholder="选择形态"
                disabled={readOnly}
                allowCustom
                onChange={(forms) => update(index, { forms } as Partial<T>)}
              />
            </label>
            <label>
              <span>参数</span>
              <MultiEnumInput
                value={row.parameters}
                options={valuesForGroup('parameter', row.parameters)}
                placeholder="选择参数"
                disabled={readOnly}
                allowCustom
                onChange={(parameters) => update(index, { parameters } as Partial<T>)}
              />
            </label>
          </div>
        </section>
        <section>
          <h4>补充说明</h4>
          <div className="row-detail-grid">
            <label className="row-detail-wide">
              <span>给采集员看的说明</span>
              <LongTextDialogEditor
                title="采集员说明"
                value={row.collectorInstruction}
                disabled={readOnly}
                placeholder="例如：牙刷可以放在洗手池台面左侧或右侧，但不要放进水槽里。"
                onChange={(collectorInstruction) => update(index, { collectorInstruction } as Partial<T>)}
              />
            </label>
            <label className="row-detail-wide">
              <span>限制条件</span>
              <LongTextDialogEditor
                title="物料状态限制条件"
                value={joinEnum(row.constraints)}
                disabled={readOnly}
                placeholder="限制条件"
                onChange={(constraints) => update(index, { constraints: splitEnum(constraints) } as Partial<T>)}
              />
            </label>
          </div>
        </section>
      </div>
    );
  }

  function imagePanel(target: StateImageUploadTarget, imageIds: string[]) {
    const images = imageIds
      .map((id) => version.attachments?.find((attachment) => attachment.id === id))
      .filter(Boolean) as RequirementAttachment[];
    const disabled = readOnly || Boolean(upload) || !storageStatus.enabled;
    return (
      <div className="state-image-panel">
        <div className="state-image-header">
          <span>示例图片</span>
          <label className={`ghost-button file-label ${disabled ? 'disabled' : ''}`} title={!storageStatus.enabled ? storageStatus.message : undefined}>
            上传图片
            <input
              type="file"
              hidden
              accept="image/*"
              disabled={disabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void bindUploadedImage(target, file);
              }}
            />
          </label>
        </div>
        {!storageStatus.enabled && <p className="state-image-warning">{storageStatus.message}</p>}
        {upload && <p className="state-image-warning">正在上传 {upload.fileName}：{upload.progress}%</p>}
        {images.length === 0 ? (
          <p className="state-image-empty">暂无示例图</p>
        ) : (
          <div className="state-image-list">
            {images.map((image) => (
              <div className="state-image-item" key={image.id}>
                <AttachmentThumbnail attachment={image} publicBaseUrl={storageStatus.publicBaseUrl} />
                <button type="button" className="text-button danger state-image-remove" disabled={readOnly} onClick={() => unbindImage(target, image.id)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function stateCard<T extends InitialLocationRow>({
    row,
    index,
    kind,
    expanded,
    toggleExpanded,
    update,
    remove,
  }: {
    row: T;
    index: number;
    kind: 'initial' | 'target';
    expanded: boolean;
    toggleExpanded: (index: number) => void;
    update: (index: number, patch: Partial<T>) => void;
    remove: (index: number) => void;
  }) {
    return (
      <section
        className="state-card"
        data-state-kind={kind}
        data-state-index={index}
        key={`${kind}-${index}-${row.object}`}
      >
        <div className="state-card-main">
          <div className="state-card-top">
            <label>
              <span>物料</span>
              <select
                className={row.object ? '' : 'placeholder-value'}
                value={row.object}
                disabled={readOnly}
                onChange={(event) => {
                  const nextRow = kind === 'initial'
                    ? emptyInitialLocationRow(event.target.value)
                    : emptyTargetStateRow(event.target.value);
                  update(index, nextRow as Partial<T>);
                }}
              >
                <option value="">选择物料</option>
                {Array.from(new Set([...materialOptions, row.object].filter(Boolean))).map((option) => (
                  <option value={option} key={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <div className="state-card-actions">
              <button type="button" className="ghost-button" onClick={() => toggleExpanded(index)}>
                {expanded ? '收起字段' : '展开编辑'}
              </button>
              <button type="button" className="text-button danger" disabled={readOnly} onClick={() => remove(index)}>
                移除
              </button>
            </div>
          </div>
          <p className="state-human-summary">{stateSentence(row)}</p>
          {row.collectorInstruction && <p className="state-instruction">采集员说明：{row.collectorInstruction}</p>}
          {expanded && stateDetailEditor({ row, index, update })}
        </div>
        {imagePanel({ kind, index }, row.exampleImageAttachmentIds)}
      </section>
    );
  }

  function stateCardList<T extends InitialLocationRow>({
    title,
    description,
    items,
    kind,
    expandedRows,
    toggleExpanded,
    update,
    remove,
    add,
    emptyText,
  }: {
    title: string;
    description: string;
    items: T[];
    kind: 'initial' | 'target';
    expandedRows: Record<number, boolean>;
    toggleExpanded: (index: number) => void;
    update: (index: number, patch: Partial<T>) => void;
    remove: (index: number) => void;
    add: () => void;
    emptyText: string;
  }) {
    return (
      <div className="embedded-table state-card-section" data-state-section={kind}>
        <div className="embedded-table-header">
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
          <button className="primary-button" disabled={readOnly} onClick={add}>
            添加状态
          </button>
        </div>
        {items.length === 0 ? (
          <div className="state-card-empty">{emptyText}</div>
        ) : (
          <div className="state-card-list">
            {items.map((row, index) =>
              stateCard({
                row,
                index,
                kind,
                expanded: expandedRows[index] ?? !readOnly,
                toggleExpanded,
                update,
                remove,
              }),
            )}
          </div>
        )}
      </div>
    );
  }

  function randomizationCard(row: MaterialInitialRandomizationRow, index: number) {
    const expanded = expandedRandomRows[index] ?? !readOnly;
    return (
      <section className="state-card" data-state-kind="material-randomization" data-state-index={index}>
        <div className="state-card-main">
          <div className="state-card-top">
            <div>
              <h4>物料状态随机性 {index + 1}</h4>
              <p className="state-human-summary">{materialRandomizationSentence(row, materialRandomOptions)}</p>
            </div>
            <div className="state-card-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setExpandedRandomRows((current) => ({ ...current, [index]: !expanded }))}
              >
                {expanded ? '收起字段' : '展开编辑'}
              </button>
              <button
                type="button"
                className="text-button danger"
                disabled={readOnly}
                onClick={() => saveMaterialInitialRandomRows(materialInitialRandomRows.filter((_, currentIndex) => currentIndex !== index))}
              >
                移除
              </button>
            </div>
          </div>
          {row.collectorInstruction && <p className="state-instruction">采集员说明：{row.collectorInstruction}</p>}
          {expanded && (
            <div className="state-card-detail">
              <section>
                <h4>怎么随机</h4>
                <div className="row-detail-grid">
                  <label>
                    <span>哪些物料</span>
                    <MultiEnumInput
                      value={row.targetMaterials}
                      options={materialOptions}
                      placeholder="选择物料"
                      disabled={readOnly}
                      onChange={(targetMaterials) => updateMaterialInitialRandomRow(index, { targetMaterials })}
                    />
                  </label>
                  <label>
                    <span>每 N 条换一次</span>
                    <input
                      type="number"
                      min={1}
                      value={row.changeIntervalRecords || 1}
                      disabled={readOnly}
                      onChange={(event) => updateMaterialInitialRandomRow(index, { changeIntervalRecords: Number(event.target.value) || 1 })}
                    />
                  </label>
                  <label>
                    <span>需要变化什么</span>
                    <MultiSelectInput
                      value={row.randomizedFields}
                      options={materialRandomOptions}
                      disabled={readOnly}
                      onChange={(randomizedFields) => updateMaterialInitialRandomRow(index, { randomizedFields })}
                    />
                  </label>
                </div>
              </section>
              <section>
                <h4>补充说明</h4>
                <div className="row-detail-grid">
                  <label className="row-detail-wide">
                    <span>给采集员看的说明</span>
                    <LongTextDialogEditor
                      title="物料状态随机性说明"
                      value={row.collectorInstruction}
                      disabled={readOnly}
                      placeholder="例如：牙刷每条都换到洗手池台面不同区域，不要放进水槽内。"
                      onChange={(collectorInstruction) => updateMaterialInitialRandomRow(index, { collectorInstruction })}
                    />
                  </label>
                  <label className="row-detail-wide">
                    <span>限制条件</span>
                    <LongTextDialogEditor
                      title="物料初始状态随机性限制条件"
                      value={row.constraints}
                      disabled={readOnly}
                      placeholder="限制条件"
                      onChange={(constraints) => updateMaterialInitialRandomRow(index, { constraints })}
                    />
                  </label>
                </div>
              </section>
            </div>
          )}
        </div>
        {imagePanel({ kind: 'randomization', index }, row.exampleImageAttachmentIds)}
      </section>
    );
  }

  return (
    <div className="state-editor">
      {stateCardList<InitialLocationRow>({
        title: '物料初始状态',
        description: '给采集员看的位置和摆放要求，先看一句话和图片，需要时再展开字段',
        items: rows,
        kind: 'initial',
        expandedRows: expandedInitialRows,
        toggleExpanded: (index) => setExpandedInitialRows((current) => ({
          ...current,
          [index]: !(current[index] ?? !readOnly),
        })),
        update: updateRow,
        remove: (index) => saveRows(rows.filter((_, currentIndex) => currentIndex !== index)),
        add: () => saveRows([...rows, emptyInitialLocationRow(materialOptions[0] || '')]),
        emptyText: '暂无物料初始状态',
      })}
      {stateCardList<TargetStateRow>({
        title: '物料目标状态',
        description: '描述操作完成后物料应该变成什么样',
        items: targetRows,
        kind: 'target',
        expandedRows: expandedTargetRows,
        toggleExpanded: (index) => setExpandedTargetRows((current) => ({
          ...current,
          [index]: !(current[index] ?? !readOnly),
        })),
        update: updateTargetRow,
        remove: (index) => saveTargetRows(targetRows.filter((_, currentIndex) => currentIndex !== index)),
        add: () => saveTargetRows([...targetRows, emptyTargetStateRow(materialOptions[0] || '')]),
        emptyText: '暂无物料目标状态',
      })}
      <div className="embedded-table state-card-section">
        <div className="embedded-table-header">
          <div>
            <h3>物料初始状态随机性</h3>
            <p>说明哪些物料要随机变化、每几条变一次，以及变化到什么范围算合格</p>
          </div>
          <button
            className="primary-button"
            disabled={readOnly}
            onClick={() =>
              saveMaterialInitialRandomRows([
                ...materialInitialRandomRows,
                {
                  targetMaterials: materialOptions[0] ? [materialOptions[0]] : [],
                  changeIntervalRecords: 1,
                  randomizedFields: [],
                  collectorInstruction: '',
                  exampleImageAttachmentIds: [],
                  constraints: '',
                },
              ])
            }
          >
            添加随机性
          </button>
        </div>
        {materialInitialRandomRows.length === 0 ? (
          <div className="state-card-empty">暂无物料初始状态随机性</div>
        ) : (
          <div className="state-card-list">
            {materialInitialRandomRows.map((row, index) => (
              <div key={`material-initial-random-${index}`}>{randomizationCard(row, index)}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MaterialPage({
  materials,
  storageStatus,
  onSave,
  onOpen,
  pageState,
  onLoadMore,
}: {
  materials: Material[];
  storageStatus: AttachmentStorageStatus;
  onSave: (material: Material) => Promise<Material | undefined>;
  onOpen: (material: Material) => Promise<Material>;
  pageState?: ResourcePageState;
  onLoadMore: () => void;
}) {
  const nextSkuId = nextReadableId(
    materials.map((material) => material.skuId),
    'SKU',
  );
  const [draft, setDraft] = useState<Material>(materials[0] || emptyMaterial(nextSkuId));
  const newDraft = useRef(false);
  const [imageUpload, setImageUpload] = useState<{ fileName: string; progress: number } | null>(null);
  const [pendingImages, setPendingImages] = useState<Array<{ file: File; attachment: RequirementAttachment }>>([]);
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;

  useEffect(() => () => {
    pendingImagesRef.current.forEach(({ attachment }) => URL.revokeObjectURL(attachment.storageKey));
  }, []);

  useEffect(() => {
    setDraft((current) => reconcileMasterDraftFromItems(current, materials, newDraft.current, emptyMaterial(nextSkuId)));
  }, [materials, nextSkuId]);

  function clearPendingImages() {
    pendingImagesRef.current.forEach(({ attachment }) => URL.revokeObjectURL(attachment.storageKey));
    setPendingImages([]);
  }

  function validateMaterialImage(file: File): boolean {
    if (!file.type.startsWith('image/')) {
      window.alert('只能上传图片文件');
      return false;
    }
    if (file.size > attachmentMaxSizeBytes) {
      window.alert('单张图片不能超过 100 MiB');
      return false;
    }
    return true;
  }

  async function persistMaterialImage(material: Material, file: File): Promise<Material> {
    const ownerName = resourceNameOf(material);
    if (!ownerName) throw new Error('物料尚未创建，无法上传图片');
    const image = await uploadOwnerAttachment(
      'materials',
      ownerName,
      file,
      (progress) => setImageUpload({ fileName: file.name, progress }),
    );
    const nextMaterial = { ...material, images: [...(material.images ?? []), image] };
    const saved = await onSave(nextMaterial);
    if (!saved) throw new Error('图片已上传，但物料引用尚未保存；请重试保存');
    return saved;
  }

  async function uploadMaterialImage(file: File) {
    if (!validateMaterialImage(file)) return;
    if (!resourceNameOf(draft)) {
      const attachment: RequirementAttachment = {
        id: `pending-${crypto.randomUUID()}`,
        name: file.name,
        size: file.size,
        contentType: file.type,
        storageKey: URL.createObjectURL(file),
        uploadedAt: new Date().toISOString(),
      };
      setPendingImages((current) => [...current, { file, attachment }]);
      return;
    }
    try {
      setImageUpload({ fileName: file.name, progress: 0 });
      setDraft(await persistMaterialImage(draft, file));
    } finally {
      setImageUpload(null);
    }
  }

  async function deleteMaterialImage(attachmentId: string) {
    const pending = pendingImages.find(({ attachment }) => attachment.id === attachmentId);
    if (pending) {
      URL.revokeObjectURL(pending.attachment.storageKey);
      setPendingImages((current) => current.filter(({ attachment }) => attachment.id !== attachmentId));
      return;
    }
    if (!draft.id) return;
    const ownerName = resourceNameOf(draft);
    if (!ownerName) throw new Error('物料资源尚未创建');
    const nextDraft = { ...draft, images: (draft.images ?? []).filter((item) => item.id !== attachmentId) };
    if (!await onSave(nextDraft)) throw new Error('物料引用尚未保存，图片未解除关联');
    await resourceClient.unlinkAttachment('materials', ownerName, attachmentId);
    setDraft(nextDraft);
  }

  const columns: Array<DataTableColumn<Material>> = [
    {
      key: 'skuId',
      title: 'SKU 编号',
      width: '180px',
      allowOverflow: true,
      render: (item) => (
        <span className="sku-with-image material-list-sku">
          <strong className="table-link">{item.skuId || '-'}</strong>
          {item.images?.[0] && <AttachmentThumbnail attachment={item.images[0]} publicBaseUrl={storageStatus.publicBaseUrl} />}
        </span>
      ),
    },
    { key: 'type', title: '物料名称', width: 'minmax(140px, 1.2fr)', render: (item) => item.type || '-' },
    { key: 'color', title: '颜色', width: '110px', render: (item) => item.color || '-' },
    { key: 'material', title: '材质', width: '130px', render: (item) => item.material || '-' },
    { key: 'packageType', title: '包装类型', width: '130px', render: (item) => item.packageType || '-' },
    { key: 'size', title: '尺寸', width: 'minmax(180px, 1.4fr)', render: (item) => item.size || '-' },
    { key: 'weight', title: '重量', width: '100px', render: (item) => item.weight || '-' },
  ];
  return (
    <MasterDataPage
      title="物料"
      description="物料主数据通过 SKU 供任务 SOP 引用"
      items={materials}
      columns={columns}
      getTitle={(item) => `${item.skuId} ${item.type}`}
      getSearchText={(item) =>
        `${item.skuId} ${item.type} ${item.color} ${item.material} ${item.packageType} ${item.size || ''} ${item.weight || ''}`
      }
      selectedId={draft.id}
      onSelect={(item) => {
        clearPendingImages();
        newDraft.current = false;
        setDraft(item);
      }}
      onResolve={onOpen}
      onNew={() => {
        clearPendingImages();
        newDraft.current = true;
        setDraft(emptyMaterial(nextSkuId));
      }}
      hasMore={Boolean(pageState?.nextCursor)}
      loadingMore={pageState?.loadingMore}
      loadMoreError={pageState?.error}
      onLoadMore={onLoadMore}
    >
      {(closeEditor) => (
        <>
          <Field label="SKU 编号" value={draft.skuId} disabled onChange={() => undefined} />
          {!draft.id && <p className="field-note">SKU 由系统自动生成，保存时会按最新数据确认最终编号。</p>}
          <AttachmentField
            title="物料图片"
            hint={draft.id ? '支持上传图片，单张不超过 100 MiB' : '图片将在保存物料时自动上传，单张不超过 100 MiB'}
            uploadLabel="上传图片"
            emptyText="暂无图片"
            accept="image/*"
            attachments={[...(draft.images || []), ...pendingImages.map(({ attachment }) => attachment)]}
            disabled={false}
            storageStatus={storageStatus}
            upload={imageUpload}
            onUpload={uploadMaterialImage}
            onDownload={(attachment) => downloadStoredAttachment(attachment)}
            onDelete={deleteMaterialImage}
          />
          <div className="material-detail-grid">
            <Field label="物料名称" value={draft.type} autoFocus={!draft.id} onChange={(type) => setDraft({ ...draft, type })} />
            <Field label="颜色" value={draft.color} onChange={(color) => setDraft({ ...draft, color })} />
            <Field label="材质" value={draft.material} onChange={(material) => setDraft({ ...draft, material })} />
            <Field label="包装类型" value={draft.packageType} onChange={(packageType) => setDraft({ ...draft, packageType })} />
            <Field label="尺寸" value={draft.size || ''} onChange={(size) => setDraft({ ...draft, size })} />
            <Field label="重量" value={draft.weight || ''} onChange={(weight) => setDraft({ ...draft, weight })} />
          </div>
          <button
            className="primary-button"
            onClick={async () => {
              let saved = await onSave(draft);
              if (!saved) return;
              newDraft.current = false;
              setDraft(saved);
              try {
                for (const pending of pendingImages) {
                  setImageUpload({ fileName: pending.file.name, progress: 0 });
                  saved = await persistMaterialImage(saved, pending.file);
                  setDraft(saved);
                }
                clearPendingImages();
                closeEditor();
              } catch (error) {
                window.alert(`物料已创建，但图片上传失败：${error instanceof Error ? error.message : String(error)}`);
              } finally {
                setImageUpload(null);
              }
            }}
          >
            保存物料
          </button>
        </>
      )}
    </MasterDataPage>
  );
}

function RobotPage({ robots, onSave, onOpen, pageState, onLoadMore }: {
  robots: RobotModel[];
  onSave: (robot: RobotModel) => Promise<RobotModel | undefined>;
  onOpen: (robot: RobotModel) => Promise<RobotModel>;
  pageState?: ResourcePageState;
  onLoadMore: () => void;
}) {
  const [draft, setDraft] = useState<RobotModel>(robots[0] || emptyRobot());
  const newDraft = useRef(false);
  useEffect(() => {
    setDraft((current) => reconcileMasterDraftFromItems(current, robots, newDraft.current, emptyRobot()));
  }, [robots]);
  const columns: Array<DataTableColumn<RobotModel>> = [
    {
      key: 'model',
      title: '型号',
      width: 'minmax(160px, 1.4fr)',
      render: (item) => <strong className="table-link">{item.model || '未命名型号'}</strong>,
    },
    { key: 'brand', title: '品牌', width: '140px', render: (item) => item.brand || '-' },
    { key: 'terminal', title: '末端', width: '160px', render: (item) => item.terminal || '-' },
    {
      key: 'topics',
      title: 'Topic 数',
      width: '100px',
      render: (item) => Object.keys(item.topics).length,
    },
  ];
  return (
    <MasterDataPage
      title="机器型号"
      description="机器型号供客户需求选择，topic 要求可在详情中维护"
      items={robots}
      columns={columns}
      getTitle={(item) => item.model}
      getSearchText={(item) =>
        `${item.brand} ${item.model} ${item.terminal} ${Object.keys(item.topics).join(' ')}`
      }
      selectedId={draft.id}
      onSelect={(item) => {
        newDraft.current = false;
        setDraft(item);
      }}
      onResolve={onOpen}
      onNew={() => {
        newDraft.current = true;
        setDraft(emptyRobot());
      }}
      hasMore={Boolean(pageState?.nextCursor)}
      loadingMore={pageState?.loadingMore}
      loadMoreError={pageState?.error}
      onLoadMore={onLoadMore}
    >
      {(closeEditor) => (
        <>
          <Field label="品牌" value={draft.brand} onChange={(brand) => setDraft({ ...draft, brand })} />
          <Field label="型号" value={draft.model} onChange={(model) => setDraft({ ...draft, model })} />
          <Field label="末端" value={draft.terminal} onChange={(terminal) => setDraft({ ...draft, terminal })} />
          <TextArea
            label="Topic（key:value，一行一个）"
            value={Object.entries(draft.topics)
              .map(([key, value]) => (value ? `${key}:${value}` : key))
              .join('\n')}
            onChange={(value) => setDraft({ ...draft, topics: keyValueLines(value) })}
          />
          <button className="primary-button" onClick={() => void onSave(draft).then((saved) => {
            if (!saved) return;
            newDraft.current = false;
            setDraft(saved);
            closeEditor();
          })}>
            保存型号
          </button>
        </>
      )}
    </MasterDataPage>
  );
}

function MasterDataPage<T extends { id: string }>({
  title,
  description,
  items,
  columns,
  getTitle,
  getSearchText,
  selectedId,
  onSelect,
  onResolve,
  onNew,
  hasMore = false,
  loadingMore = false,
  loadMoreError,
  onLoadMore,
  children,
}: {
  title: string;
  description: string;
  items: T[];
  columns: Array<DataTableColumn<T>>;
  getTitle: (item: T) => string;
  getSearchText: (item: T) => string;
  selectedId: string;
  onSelect: (item: T) => void;
  onResolve?: (item: T) => Promise<T>;
  onNew: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMoreError?: string;
  onLoadMore?: () => void;
  children: ReactNode | ((closeEditor: () => void) => ReactNode);
}) {
  const [query, setQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState('');
  const filteredItems = items.filter((item) => matchesQuery(query, [item.id, getTitle(item), getSearchText(item)]));

  async function openItemEditor(item: T) {
    setEditorOpen(true);
    setDetailError('');
    onSelect(item);
    if (!onResolve) return;
    setLoadingDetail(true);
    try {
      onSelect(await onResolve(item));
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingDetail(false);
    }
  }

  function openNewItemEditor() {
    onNew();
    setEditorOpen(true);
  }

  return (
    <div className="page-stack">
      <section className="panel table-panel">
        <SearchPanel
          title={`${title}列表`}
          description={description}
          query={query}
          placeholder={`搜索${title}名称、编号或字段`}
          count={filteredItems.length}
          onQueryChange={setQuery}
          actions={
            <button className="primary-button" onClick={openNewItemEditor}>
              新建{title}
            </button>
          }
        />
        <DataTable
          rows={filteredItems}
          columns={columns}
          rowKey={(item) => item.id || getTitle(item)}
          selectedKey={selectedId}
          emptyText={`没有匹配的${title}`}
          onRowClick={(item) => void openItemEditor(item)}
        />
        {(hasMore || loadMoreError) && (
          <div className="form-actions">
            <button className="ghost-button" disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? '正在加载…' : '加载更多'}
            </button>
            {loadMoreError && <span className="notice error">{loadMoreError}</span>}
          </div>
        )}
      </section>
      {editorOpen && (
        <Modal
          title={`${title}详情`}
          closeOnBackdrop={false}
          onClose={() => setEditorOpen(false)}
        >
          <div className="form-stack modal-form-stack">
            {loadingDetail && <div className="loading">正在加载资源详情…</div>}
            {detailError && <div className="notice error">{detailError}</div>}
            {!loadingDetail && !detailError && (typeof children === 'function' ? children(() => setEditorOpen(false)) : children)}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  disabled = false,
  autoFocus = false,
}: {
  label: string;
  value: string;
  type?: 'text' | 'number' | 'date';
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    if (draft !== value) {
      onChange(draft);
    }
  }

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={draft}
        disabled={disabled}
        autoFocus={autoFocus}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composingRef.current) {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function CommitField({
  label,
  value,
  onChange,
  type = 'text',
  disabled = false,
}: {
  label: string;
  value: string;
  type?: 'text' | 'number' | 'date';
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    const nextValue = draft.trim();
    if (nextValue !== value) {
      onChange(nextValue);
    }
  }

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={draft}
        disabled={disabled}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composingRef.current) {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function InlineTextInput({
  value,
  placeholder = '',
  disabled = false,
  className = '',
  onCommit,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    const nextValue = draft.trim();
    if (nextValue !== value) {
      onCommit(nextValue);
    }
  }

  return (
    <input
      className={className}
      type="text"
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        setDraft(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !composingRef.current) {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function InlineNumberInput({
  value,
  disabled = false,
  min = 0,
  className = '',
  onCommit,
}: {
  value: number;
  disabled?: boolean;
  min?: number;
  className?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const nextValue = Number(draft);
    const normalizedValue = Number.isFinite(nextValue) ? Math.max(min, nextValue) : min;
    const normalizedDraft = String(normalizedValue);
    setDraft(normalizedDraft);
    if (normalizedValue !== value) {
      onCommit(normalizedValue);
    }
  }

  return (
    <input
      className={className}
      type="number"
      min={min}
      value={draft}
      disabled={disabled}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function SelectField({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        className={value ? '' : 'placeholder-value'}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextArea({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    if (draft !== value) {
      onChange(draft);
    }
  }

  return (
    <label className="field wide">
      <span>{label}</span>
      <textarea
        value={draft}
        disabled={disabled}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !composingRef.current) {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function AttachmentField({
  title = '客户附件',
  hint = '单个附件不超过 100 MiB，支持分片上传',
  uploadLabel = '上传附件',
  emptyText = '暂无附件',
  accept,
  attachments,
  disabled,
  storageStatus = defaultAttachmentStorageStatus,
  upload,
  onUpload,
  onDownload,
  onDelete,
}: {
  title?: string;
  hint?: string;
  uploadLabel?: string;
  emptyText?: string;
  accept?: string;
  attachments: RequirementAttachment[];
  disabled: boolean;
  storageStatus?: AttachmentStorageStatus;
  upload: { fileName: string; progress: number } | null;
  onUpload: (file: File) => Promise<void>;
  onDownload: (attachment: RequirementAttachment) => Promise<void>;
  onDelete: (attachmentId: string) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewAttachment, setPreviewAttachment] = useState<RequirementAttachment | null>(null);
  const uploadDisabled = disabled || Boolean(upload) || !storageStatus.enabled;

  async function pickFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    for (const file of files) {
      await onUpload(file);
    }
  }

  return (
    <div className="attachment-field">
      <div className="attachment-panel">
        <div className="attachment-panel-header">
          <div>
            <strong>{title}</strong>
            <span>{hint}</span>
          </div>
          <button className="primary-button" disabled={uploadDisabled} title={!storageStatus.enabled ? storageStatus.message : undefined} onClick={() => inputRef.current?.click()}>
            {uploadLabel}
          </button>
          <input ref={inputRef} type="file" multiple hidden accept={accept} onChange={(event) => void pickFiles(event)} />
        </div>
        {!storageStatus.enabled && <div className="attachment-storage-warning">{storageStatus.message}</div>}
        {upload && (
          <div className="attachment-upload-progress">
            <span>{upload.fileName}</span>
            <progress value={upload.progress} max={100} />
            <strong>{upload.progress}%</strong>
          </div>
        )}
        {attachments.length === 0 ? (
          <div className="attachment-empty">{emptyText}</div>
        ) : (
          <div className="attachment-list">
            {attachments.map((attachment) => (
              <div className="attachment-row" key={attachment.id}>
                <div className="attachment-main">
                  <AttachmentPreviewThumb
                    attachment={attachment}
                    publicBaseUrl={storageStatus.publicBaseUrl}
                    onPreview={() => setPreviewAttachment(attachment)}
                  />
                  <div>
                    <button type="button" className="attachment-name-button" onClick={() => setPreviewAttachment(attachment)}>
                      {attachment.name}
                    </button>
                    <span>
                      {formatFileSize(attachment.size)} · {formatShortDate(attachment.uploadedAt)}
                    </span>
                  </div>
                </div>
                <div className="button-row">
                  <button className="text-button" onClick={() => setPreviewAttachment(attachment)}>
                    预览
                  </button>
                  <button className="text-button" onClick={() => void onDownload(attachment)}>
                    下载
                  </button>
                  <button className="text-button danger" disabled={disabled} onClick={() => void onDelete(attachment.id)}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {previewAttachment && (
        <AttachmentPreviewModal
          attachment={previewAttachment}
          publicBaseUrl={storageStatus.publicBaseUrl}
          onClose={() => setPreviewAttachment(null)}
          onDownload={() => onDownload(previewAttachment)}
        />
      )}
    </div>
  );
}

function AttachmentPreviewThumb({
  attachment,
  publicBaseUrl,
  onPreview,
  compact = false,
}: {
  attachment: RequirementAttachment;
  publicBaseUrl?: string;
  onPreview: () => void;
  compact?: boolean;
}) {
  const isImage = attachment.contentType.startsWith('image/');
  const isVideo = attachment.contentType.startsWith('video/');
  const url = isImage ? publicAttachmentUrl(publicBaseUrl, attachment.storageKey) : '';

  return (
    <button
      type="button"
      className={`attachment-preview-thumb ${compact ? 'compact' : ''}`}
      aria-label={`预览附件 ${attachment.name}`}
      onClick={(event) => {
        event.stopPropagation();
        onPreview();
      }}
      title="点击预览"
    >
      {isImage && url ? <img src={url} alt={attachment.name} /> : <span>{isVideo ? '视频' : isImage ? '图片' : '文件'}</span>}
    </button>
  );
}

function AttachmentPreviewModal({
  attachment,
  publicBaseUrl,
  onClose,
  onDownload,
}: {
  attachment: RequirementAttachment;
  publicBaseUrl?: string;
  onClose: () => void;
  onDownload: () => Promise<void>;
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  const isImage = attachment.contentType.startsWith('image/');
  const isVideo = attachment.contentType.startsWith('video/');
  const publicUrl = publicAttachmentUrl(publicBaseUrl, attachment.storageKey);

  useEffect(() => {
    setLoadFailed(false);
  }, [attachment.id, publicUrl]);

  return (
    <Modal title={`预览：${attachment.name}`} panelClassName="attachment-preview-panel" onClose={onClose}>
      <div className="attachment-preview-modal">
        <div className="attachment-preview-stage">
          {isImage && publicUrl && <img src={publicUrl} alt={attachment.name} onError={() => setLoadFailed(true)} />}
          {isVideo && publicUrl && <video src={publicUrl} controls onError={() => setLoadFailed(true)} />}
          {(isImage || isVideo) && !publicUrl && <div className="attachment-preview-fallback">附件未配置公开访问链接，无法在线预览。</div>}
          {(!isImage && !isVideo) && <div className="attachment-preview-fallback">当前文件类型不支持在线预览，可以下载后查看。</div>}
          {loadFailed && <div className="attachment-preview-fallback">预览加载失败，可以下载后查看。</div>}
        </div>
        <div className="attachment-preview-meta">
          <span>{attachment.contentType || '未知类型'}</span>
          <span>{formatFileSize(attachment.size)}</span>
          <span>{formatShortDate(attachment.uploadedAt)}</span>
        </div>
        <div className="form-actions">
          {publicUrl && (
            <a className="ghost-button" href={publicUrl} target="_blank" rel="noreferrer">
              新窗口打开
            </a>
          )}
          <button className="primary-button" onClick={() => void onDownload()}>
            下载
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AttachmentThumbnail({ attachment, publicBaseUrl }: { attachment: RequirementAttachment; publicBaseUrl?: string }) {
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <>
      <AttachmentPreviewThumb attachment={attachment} publicBaseUrl={publicBaseUrl} compact onPreview={() => setPreviewOpen(true)} />
      {previewOpen && (
        <AttachmentPreviewModal
          attachment={attachment}
          publicBaseUrl={publicBaseUrl}
          onClose={() => setPreviewOpen(false)}
          onDownload={() => downloadStoredAttachment(attachment)}
        />
      )}
    </>
  );
}

function keyValueLines(value: string): Record<string, string> {
  return value.split('\n').reduce<Record<string, string>>((acc, line) => {
    const [key, ...rest] = line.split(':');
    if (key?.trim()) {
      acc[key.trim()] = rest.join(':').trim();
    }
    return acc;
  }, {});
}

function operationItemsFromOptions(options: Option[]): RequirementVersion['allowedOperations'] {
  return options.map((option) => ({ operation: option.value, note: option.description || '' }));
}

function forbiddenGroupsFromKeys(keys: string[], options: Option[]): RequirementVersion['forbiddenOperations'] {
  const groups = new Map<string, Array<{ operation: string; note: string }>>();
  keys.forEach((operation) => {
    const option = options.find((item) => item.value === operation);
    const [category, ...rest] = operation.split('/');
    const hasCategory = rest.length > 0 && category.trim();
    const groupName = hasCategory ? category.trim() : '';
    const operationName = hasCategory ? rest.join('/').trim() : operation;
    const current = groups.get(groupName) || [];
    current.push({ operation: operationName, note: option?.description || '' });
    groups.set(groupName, current);
  });
  return Array.from(groups.entries()).map(([category, operations]) => ({ category, operations }));
}

function joinEnum(values: string[]): string {
  return values.filter(Boolean).join('、');
}

function splitEnum(value: string | undefined): string[] {
  return (value || '')
    .split(/[、，,\\/]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function emptyInitialLocationRow(object = ''): InitialLocationRow {
  return {
    object,
    primaryReferences: [],
    primaryRelativePositions: [],
    supportSurfaces: [],
    regions: [],
    secondaryReferences: [],
    secondaryRelativePositions: [],
    poses: [],
    forms: [],
    parameters: [],
    collectorInstruction: '',
    exampleImageAttachmentIds: [],
    constraints: [],
  };
}

function initialStateRows(states: SubsceneVersion['objectStates']['initial']): InitialLocationRow[] {
  return states.flatMap((state) =>
    state.allowedLocations.map((location) => {
      const primary = location.referencePath.find((item) => item.level === 1);
      const secondary = location.referencePath.find((item) => item.level === 2);
      return {
        object: state.object,
        primaryReferences: splitEnum(primary?.referenceObject),
        primaryRelativePositions: splitEnum(primary?.relativePosition),
        supportSurfaces: splitEnum(location.supportSurface),
        regions: location.allowedRegions,
        secondaryReferences: splitEnum(secondary?.referenceObject),
        secondaryRelativePositions: splitEnum(secondary?.relativePosition),
        poses: location.allowedPose,
        forms: location.allowedForm,
        parameters: (location as { parameters?: string[] }).parameters || [],
        collectorInstruction: location.collectorInstruction || '',
        exampleImageAttachmentIds: location.exampleImageAttachmentIds || [],
        constraints: location.constraints,
      };
    }),
  );
}

function initialStatesFromRows(rows: InitialLocationRow[]): SubsceneVersion['objectStates']['initial'] {
  const states = new Map<string, SubsceneVersion['objectStates']['initial'][number]>();
  for (const row of rows) {
    if (!row.object) continue;
    const current = states.get(row.object) || { object: row.object, allowedLocations: [] };
    const referencePath = [
      row.primaryReferences.length || row.primaryRelativePositions.length
        ? {
            level: 1,
            referenceObject: joinEnum(row.primaryReferences),
            relativePosition: joinEnum(row.primaryRelativePositions),
          }
        : undefined,
      row.secondaryReferences.length || row.secondaryRelativePositions.length
        ? {
            level: 2,
            referenceObject: joinEnum(row.secondaryReferences),
            relativePosition: joinEnum(row.secondaryRelativePositions),
          }
        : undefined,
    ].filter(Boolean) as SubsceneVersion['objectStates']['initial'][number]['allowedLocations'][number]['referencePath'];
    current.allowedLocations.push({
      location: joinEnum([...row.primaryReferences, ...row.primaryRelativePositions, ...row.regions]),
      referencePath,
      supportSurface: joinEnum(row.supportSurfaces),
      allowedRegions: row.regions,
      allowedPose: row.poses,
      allowedForm: row.forms,
      parameters: row.parameters,
      collectorInstruction: row.collectorInstruction,
      exampleImageAttachmentIds: row.exampleImageAttachmentIds,
      constraints: row.constraints,
    });
    states.set(row.object, current);
  }
  return Array.from(states.values());
}

function targetStateRows(states: SubsceneVersion['objectStates']['target']): TargetStateRow[] {
  return states.map((state) => {
    const primary = state.referencePath?.find((item) => item.level === 1);
    const secondary = state.referencePath?.find((item) => item.level === 2);
    return {
      object: state.object,
      primaryReferences: splitEnum(primary?.referenceObject || state.requiredLocation),
      primaryRelativePositions: splitEnum(primary?.relativePosition),
      supportSurfaces: splitEnum(state.supportSurface),
      regions: state.requiredRegions,
      secondaryReferences: splitEnum(secondary?.referenceObject),
      secondaryRelativePositions: splitEnum(secondary?.relativePosition),
      poses: state.requiredPose,
      forms: state.requiredForm,
      parameters: state.parameters || [],
      collectorInstruction: state.collectorInstruction || '',
      exampleImageAttachmentIds: state.exampleImageAttachmentIds || [],
      constraints: state.constraints || [],
    };
  });
}

function targetStatesFromRows(rows: TargetStateRow[]): SubsceneVersion['objectStates']['target'] {
  return rows
    .filter((row) => row.object)
    .map((row) => {
      const referencePath = [
        row.primaryReferences.length || row.primaryRelativePositions.length
          ? {
              level: 1,
              referenceObject: joinEnum(row.primaryReferences),
              relativePosition: joinEnum(row.primaryRelativePositions),
            }
          : undefined,
        row.secondaryReferences.length || row.secondaryRelativePositions.length
          ? {
              level: 2,
              referenceObject: joinEnum(row.secondaryReferences),
              relativePosition: joinEnum(row.secondaryRelativePositions),
            }
          : undefined,
      ].filter(Boolean) as NonNullable<SubsceneVersion['objectStates']['target'][number]['referencePath']>;
      return {
        object: row.object,
        requiredLocation: joinEnum([...row.primaryReferences, ...row.primaryRelativePositions, ...row.regions]),
        requiredRegions: row.regions,
        requiredPose: row.poses,
        requiredForm: row.forms,
        referencePath,
        supportSurface: joinEnum(row.supportSurfaces),
        parameters: row.parameters,
        collectorInstruction: row.collectorInstruction,
        exampleImageAttachmentIds: row.exampleImageAttachmentIds,
        constraints: row.constraints,
      };
    });
}

function emptyTargetStateRow(object = ''): TargetStateRow {
  return emptyInitialLocationRow(object);
}

function robotInitialRandomizationRows(
  randomization: SubsceneVersion['randomization'],
  legacyFrequency?: string,
  options: Option[] = [],
): RobotInitialRandomizationRow[] {
  const robotInitialState = randomization.robotInitialState;
  if (!robotInitialState.enabled && robotInitialState.randomizedFields.length === 0) {
    return [];
  }
  const constraints = Array.from(new Set(robotInitialState.randomizedFields.flatMap((field) => field.constraints))).filter(Boolean);
  return [
    {
      target: '机器人初始态',
      changeIntervalRecords: robotInitialState.changeIntervalRecords || Number(legacyFrequency) || 1,
      randomizedFields: robotInitialState.randomizedFields.map((field) => globalFieldValueForStoredField(field, options)),
      constraints: joinEnum(constraints),
    },
  ];
}

function robotInitialRandomizationPatch(
  version: SubsceneVersion,
  rows: RobotInitialRandomizationRow[],
  options: Option[] = [],
): Partial<SubsceneVersion> {
  const row = rows[0];
  const randomizedFields = row
    ? row.randomizedFields.map((field) => ({
        field,
        displayName: options.find((option) => option.value === field)?.label || field,
        constraints: splitEnum(row.constraints),
      }))
    : [];
  const changeIntervalRecords = row?.changeIntervalRecords || 1;
  return {
    robotInitialRandomizationRequirements: row?.randomizedFields || [],
    randomizationFrequency: String(changeIntervalRecords),
    randomization: {
      ...version.randomization,
      robotInitialState: {
        ...version.randomization.robotInitialState,
        enabled: Boolean(row),
        changeFrequency: 'every_n_records',
        changeIntervalRecords,
        randomizedFields,
      },
    },
  };
}

function materialInitialRandomizationRows(randomization: SubsceneVersion['randomization']): MaterialInitialRandomizationRow[] {
  return randomization.materialInitialState.rules.map((rule) => ({
    targetMaterials: rule.targetMaterials,
    changeIntervalRecords: rule.changeIntervalRecords || 1,
    randomizedFields: [
      ...rule.randomizedFields.locations.map((item) => item.name),
      ...rule.randomizedFields.poses.map((item) => item.name),
      ...rule.randomizedFields.forms.map((item) => item.name),
    ],
    collectorInstruction: rule.collectorInstruction || '',
    exampleImageAttachmentIds: rule.exampleImageAttachmentIds || [],
    constraints: joinEnum(rule.constraints),
  }));
}

function materialInitialRandomizationFromRows(rows: MaterialInitialRandomizationRow[]): SubsceneVersion['randomization']['materialInitialState']['rules'] {
  return rows
    .filter((row) => row.targetMaterials.length > 0)
    .map((row) => ({
      targetMaterials: row.targetMaterials,
      changeFrequency: 'every_n_records',
      changeIntervalRecords: row.changeIntervalRecords || 1,
      randomizedFields: {
        locations: row.randomizedFields
          .filter((name) => name.includes('location') || name.includes('位置'))
          .map((name) => ({ name, valueSource: 'object_states.initial.allowed_locations' })),
        poses: row.randomizedFields
          .filter((name) => name.includes('pose') || name.includes('姿态'))
          .map((name) => ({ name, valueSource: 'object_states.initial.allowed_locations.allowed_pose' })),
        forms: row.randomizedFields
          .filter((name) => name.includes('form') || name.includes('形态'))
          .map((name) => ({ name, valueSource: 'object_states.initial.allowed_locations.allowed_form' })),
      },
      collectorInstruction: row.collectorInstruction,
      exampleImageAttachmentIds: row.exampleImageAttachmentIds,
      constraints: splitEnum(row.constraints),
    }));
}

function emptySubsceneVersionDraft(title = '新的任务 SOP'): Partial<SubsceneVersion> {
  const now = new Date().toISOString();
  return {
    version: '0.0.1',
    createdAt: now,
    updatedAt: now,
    status: 'draft',
    title,
    description: '',
    materials: [],
    robotState: { initial: '', target: '' },
    robotOperationRequirements: '',
    robotInitialRandomizationRequirements: [],
    randomizationFrequency: '1',
    randomization: {
      robotInitialState: {
        enabled: true,
        changeFrequency: 'every_n_records',
        changeIntervalRecords: 1,
        randomizedFields: [],
      },
      materialInitialState: { rules: [] },
    },
    operation: {
      stepOrder: '',
      steps: [],
      stepRandomization: { enabled: false, startOrder: 1, endOrder: 1 },
      allowedOperations: [],
      acceptableOperations: [],
      forbiddenOperations: [],
    },
    objectStates: { initial: [], target: [] },
    materialStateRules: [],
    annotation: {
      status: 'pending',
      note: '',
      actionTags: [],
      steps: [],
      allowedOperations: [],
      forbiddenOperations: [],
      stepRandomization: { enabled: false, startOrder: 1, endOrder: 1 },
    },
    references: { recordUrls: [], attachments: [] },
  };
}

function emptyRequirementVersion(title = '新的客户需求', status: EntityStatus = 'draft'): RequirementVersion {
  const now = new Date().toISOString();
  return {
    version: '0.0.1',
    status,
    title,
    projectName: '',
    priority: 'P2',
    deadline: today(),
    customerId: '',
    robotModelId: '',
    businessGoal: '',
    requestedScenes: [],
    requiredDurationHours: 0,
    allowedOperations: [],
    acceptableOperations: [],
    forbiddenOperations: [],
    annotation: { required: false, types: [], allowedOperations: [], forbiddenOperations: [] },
    qualityInspection: { required: false, samplingPolicy: '' },
    delivery: { formats: [], method: '', languages: [], dataStructureUrl: '' },
    selectedSubscenes: [],
    attachments: [],
    createdAt: now,
    updatedAt: now,
  };
}

function emptyCustomer(): Customer {
  return {
    id: '',
    name: '',
    contact: { name: '', phone: '', email: '' },
    notes: '',
  };
}

function emptyMaterial(skuId = ''): Material {
  return {
    id: '',
    skuId,
    type: '',
    color: '',
    material: '',
    packageType: '',
    images: [],
  };
}

function emptyRobot(): RobotModel {
  return {
    id: '',
    brand: '',
    model: '',
    terminal: '',
    topics: {},
    extraTopicRequirements: {},
  };
}

function emptyScene(name = '新的场景'): Scene {
  return {
    id: '',
    name,
    description: '',
    subscenes: [],
  };
}

function emptyGlobalField(group: GlobalFieldGroup = 'reference_object'): GlobalField {
  return {
    id: '',
    group,
    label: '',
    value: '',
    description: '',
    status: 'active',
    updatedAt: new Date().toISOString(),
  };
}
