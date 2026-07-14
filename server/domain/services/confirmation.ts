import { create, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import {
  AttachmentSchema,
  CustomerSchema,
  FrozenDependencyContextSchema,
  MaterialSchema,
  MaterialStateRuleSchema,
  RobotModelRevisionSchema,
  SceneSchema,
  type Attachment,
  type Customer,
  type FrozenDependencyContext,
  type Material,
  type MaterialStateRule,
  type RobotModelRevision,
  type Scene,
} from '../../../gen/coscene/sop/v1alpha1/catalog_pb';
import { DependencyKind, Lifecycle } from '../../../gen/coscene/sop/v1alpha1/common_pb';
import {
  RequirementRevisionSchema,
  RequirementSchema,
  type Requirement,
  type RequirementRevision,
} from '../../../gen/coscene/sop/v1alpha1/requirement_pb';
import {
  TaskSopRevisionSchema,
  TaskSopSchema,
  type TaskSop,
  type TaskSopRevision,
} from '../../../gen/coscene/sop/v1alpha1/task_sop_pb';
import { fromDomainJsonString, toDomainJson } from '../../../shared/domain/codec';
import { assertValidDomainMessage } from '../../../shared/domain/validation';
import type {
  AtomicConfirmationResult,
  CatalogResourceKind,
  CatalogResourceRecord,
  CurrentResourceRecord,
  ResourceRepository,
  ReviewedDependency,
  RevisionRecord,
} from '../repository';
import { ResourceConflictError, ResourceNotFoundError } from '../repository';
import { deterministicUid } from '../identity';
import { CanonicalDataError } from '../errors';
import { buildExportBundle } from '../../export/bundle';
import { encodeExportBundle } from '../../export/codec';
import { resolveExportClosure } from '../../export/closure';
import {
  buildDependencyReviewProposal,
  diffDependencies,
  MAX_DIRECT_DEPENDENCIES,
  type DependencyDiff,
  type DirectDependency,
} from './dependencyReview';
import { buildRequirementConfirmation, buildTaskSopConfirmation } from './versioning';

type CatalogCollections = {
  customers: Customer[];
  materials: Material[];
  scenes: Scene[];
  materialStateRules: MaterialStateRule[];
  attachments: Attachment[];
};

type RootResolution = {
  root: CurrentResourceRecord;
  message: TaskSop | Requirement;
  direct: DirectDependency[];
  reviewedWrites: ReviewedDependency[];
  frozenDependencies: FrozenDependencyContext;
  taskSopRevisions: TaskSopRevision[];
  robotModelRevisions: RobotModelRevision[];
};

export class DependencyReviewRequiredError extends Error {
  constructor(readonly diff: DependencyDiff) {
    super('Direct dependencies must be reviewed before confirmation');
    this.name = 'DependencyReviewRequiredError';
  }
}

function isDependencyCommitRace(error: unknown): boolean {
  return error instanceof Error && [
    'dependency guard: stale etag token',
    'dependency guard: stale revision token',
    'confirmation guard: dependency changed',
  ].some((message) => error.message.includes(message));
}

function protoJson<Desc extends DescMessage>(schema: Desc, value: MessageShape<Desc>): string {
  return JSON.stringify(toDomainJson(schema, value));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en'));
}

function revisionUidDependency(kind: DependencyKind, record: RevisionRecord): DirectDependency {
  return { kind, resourceName: record.name, token: record.uid };
}

function roleFor(kind: DependencyKind): string {
  switch (kind) {
    case DependencyKind.CUSTOMER: return 'CUSTOMER';
    case DependencyKind.MATERIAL: return 'MATERIAL';
    case DependencyKind.SCENE: return 'SCENE';
    case DependencyKind.GLOBAL_FIELD: return 'GLOBAL_FIELD';
    case DependencyKind.MATERIAL_STATE_RULE: return 'MATERIAL_STATE_RULE';
    case DependencyKind.ATTACHMENT: return 'ATTACHMENT';
    case DependencyKind.TASK_SOP_REVISION: return 'TASK_SOP_REVISION';
    case DependencyKind.ROBOT_MODEL_REVISION: return 'ROBOT_MODEL_REVISION';
    default: throw new CanonicalDataError(`Unsupported dependency kind: ${kind}`);
  }
}

function kindForRole(role: string): DependencyKind {
  switch (role) {
    case 'CUSTOMER': return DependencyKind.CUSTOMER;
    case 'MATERIAL': return DependencyKind.MATERIAL;
    case 'SCENE': return DependencyKind.SCENE;
    case 'GLOBAL_FIELD': return DependencyKind.GLOBAL_FIELD;
    case 'MATERIAL_STATE_RULE': return DependencyKind.MATERIAL_STATE_RULE;
    case 'ATTACHMENT': return DependencyKind.ATTACHMENT;
    case 'TASK_SOP_REVISION': return DependencyKind.TASK_SOP_REVISION;
    case 'ROBOT_MODEL_REVISION': return DependencyKind.ROBOT_MODEL_REVISION;
    default: throw new CanonicalDataError(`Unsupported reviewed dependency role: ${role}`);
  }
}

function reviewedAsDirect(values: ReviewedDependency[]): DirectDependency[] {
  return values.map((value) => ({
    kind: kindForRole(value.dependencyRole),
    resourceName: value.dependencyName,
    token: value.reviewedToken,
  }));
}

function referencedTaskAttachments(task: TaskSop): string[] {
  const names = new Set(task.attachments);
  for (const object of task.spec?.objects ?? []) for (const name of object.images) names.add(name);
  for (const state of task.spec?.objectStates?.initial ?? []) {
    for (const location of state.allowedLocations) for (const name of location.exampleImages) names.add(name);
  }
  for (const state of task.spec?.objectStates?.target ?? []) {
    for (const name of state.requiredLocation?.exampleImages ?? []) names.add(name);
  }
  for (const rule of task.spec?.randomization?.objectInitialStates ?? []) {
    for (const name of rule.exampleImages) names.add(name);
  }
  return uniqueSorted(names);
}

function assertCatalogKind(record: CatalogResourceRecord, expected: CatalogResourceKind): void {
  if (record.kind !== expected) throw new CanonicalDataError(`Dependency kind mismatch: ${record.name}`);
  if (record.archivedAt) throw new CanonicalDataError(`Dependency is archived: ${record.name}`);
}

function catalogMap(records: CatalogResourceRecord[]): Map<string, CatalogResourceRecord> {
  return new Map(records.map((record) => [record.name, record]));
}

function revisionMap(records: RevisionRecord[]): Map<string, RevisionRecord> {
  return new Map(records.map((record) => [record.name, record]));
}

function requireCatalog<Desc extends DescMessage>(
  records: Map<string, CatalogResourceRecord>,
  name: string,
  kind: CatalogResourceKind,
  schema: Desc,
): { record: CatalogResourceRecord; value: MessageShape<Desc> } {
  const record = records.get(name);
  if (!record) throw new ResourceNotFoundError(name);
  assertCatalogKind(record, kind);
  return { record, value: fromDomainJsonString(schema, record.protoJson) };
}

function requireRevision<Desc extends DescMessage>(
  records: Map<string, RevisionRecord>,
  name: string,
  expectedKind: RevisionRecord['kind'],
  schema: Desc,
): { record: RevisionRecord; value: MessageShape<Desc> } {
  const record = records.get(name);
  if (!record) throw new ResourceNotFoundError(name);
  if (record.kind !== expectedKind || record.lifecycle !== 'CONFIRMED' ||
    record.revisionOrigin === 'IMPORTED_DRAFT_CHECKPOINT') {
    throw new CanonicalDataError(`Dependency revision is not selectable: ${name}`);
  }
  if (expectedKind !== 'ROBOT_MODEL_REVISION' && !record.exportEligible) {
    throw new CanonicalDataError(`Dependency revision is not export eligible: ${name}`);
  }
  return { record, value: fromDomainJsonString(schema, record.revisionProtoJson) };
}

function assertDependencyLookupLimit(values: Array<Pick<DirectDependency, 'kind' | 'resourceName'>>): void {
  const count = new Set(values.map((value) => `${value.kind}\0${value.resourceName}`)).size;
  if (count > MAX_DIRECT_DEPENDENCIES) {
    throw new CanonicalDataError(`Direct dependency limit exceeded: ${count} > ${MAX_DIRECT_DEPENDENCIES}`);
  }
}

function catalogDirect(kind: DependencyKind, record: CatalogResourceRecord): DirectDependency {
  return { kind, resourceName: record.name, token: record.etag };
}

function dedupeDirect(values: DirectDependency[]): DirectDependency[] {
  const result = new Map<string, DirectDependency>();
  for (const value of values) result.set(`${value.kind}\0${value.resourceName}`, value);
  return [...result.values()].sort((left, right) =>
    left.kind - right.kind || left.resourceName.localeCompare(right.resourceName, 'en'));
}

function toReviewedWrites(
  rootName: string,
  direct: DirectDependency[],
  records: Map<string, { uid: string }>,
  createdAt: string,
): ReviewedDependency[] {
  return direct.map((dependency) => {
    const record = records.get(dependency.resourceName);
    if (!record) throw new CanonicalDataError(`Resolved dependency metadata is missing: ${dependency.resourceName}`);
    const revision = dependency.kind === DependencyKind.TASK_SOP_REVISION ||
      dependency.kind === DependencyKind.ROBOT_MODEL_REVISION;
    return {
      rootName,
      dependencyRole: roleFor(dependency.kind),
      dependencyName: dependency.resourceName,
      dependencyUid: record.uid,
      tokenKind: revision ? 'REVISION_UID' : 'ETAG',
      reviewedToken: dependency.token,
      createdAt,
    };
  });
}

async function resolveTaskDependencies(
  repository: ResourceRepository,
  root: CurrentResourceRecord,
  task: TaskSop,
  now: string,
): Promise<RootResolution> {
  const collections: CatalogCollections = {
    customers: [], materials: [], scenes: [], materialStateRules: [], attachments: [],
  };
  const direct: DirectDependency[] = [];
  const records = new Map<string, { uid: string }>();
  const materialNames = uniqueSorted(
    (task.spec?.objects ?? []).flatMap((object) => object.material ? [object.material] : []),
  );
  const ruleNames = uniqueSorted((task.spec?.materialStateRules ?? []).map((rule) => rule.name));
  const attachmentNames = new Set(referencedTaskAttachments(task));
  assertDependencyLookupLimit([
    { kind: DependencyKind.SCENE, resourceName: task.scene },
    ...materialNames.map((resourceName) => ({ kind: DependencyKind.MATERIAL, resourceName })),
    ...ruleNames.map((resourceName) => ({ kind: DependencyKind.MATERIAL_STATE_RULE, resourceName })),
    ...[...attachmentNames].map((resourceName) => ({ kind: DependencyKind.ATTACHMENT, resourceName })),
  ]);
  const initialCatalogs = catalogMap(await repository.getCatalogs([
    task.scene,
    ...materialNames,
    ...ruleNames,
  ]));

  const scene = requireCatalog(initialCatalogs, task.scene, 'SCENE', SceneSchema);
  collections.scenes.push(scene.value);
  records.set(scene.record.name, scene.record);
  direct.push(catalogDirect(DependencyKind.SCENE, scene.record));

  for (const name of materialNames) {
    const material = requireCatalog(initialCatalogs, name, 'MATERIAL', MaterialSchema);
    collections.materials.push(material.value);
    records.set(material.record.name, material.record);
    direct.push(catalogDirect(DependencyKind.MATERIAL, material.record));
  }

  for (const name of ruleNames) {
    const rule = requireCatalog(initialCatalogs, name, 'MATERIAL_STATE_RULE', MaterialStateRuleSchema);
    collections.materialStateRules.push(rule.value);
    records.set(rule.record.name, rule.record);
    direct.push(catalogDirect(DependencyKind.MATERIAL_STATE_RULE, rule.record));
  }

  for (const material of collections.materials) for (const name of material.images) attachmentNames.add(name);
  assertDependencyLookupLimit([
    ...direct,
    ...[...attachmentNames].map((resourceName) => ({ kind: DependencyKind.ATTACHMENT, resourceName })),
  ]);
  const attachmentCatalogs = catalogMap(await repository.getCatalogs(uniqueSorted(attachmentNames)));
  for (const name of uniqueSorted(attachmentNames)) {
    const attachment = requireCatalog(attachmentCatalogs, name, 'ATTACHMENT', AttachmentSchema);
    collections.attachments.push(attachment.value);
    records.set(attachment.record.name, attachment.record);
    direct.push(catalogDirect(DependencyKind.ATTACHMENT, attachment.record));
  }

  const normalized = dedupeDirect(direct);
  return {
    root,
    message: task,
    direct: normalized,
    reviewedWrites: toReviewedWrites(root.name, normalized, records, now),
    frozenDependencies: create(FrozenDependencyContextSchema, collections),
    taskSopRevisions: [],
    robotModelRevisions: [],
  };
}

async function resolveRequirementDependencies(
  repository: ResourceRepository,
  root: CurrentResourceRecord,
  requirement: Requirement,
  now: string,
): Promise<RootResolution> {
  if (!requirement.spec) throw new CanonicalDataError('Requirement spec is missing');
  const direct: DirectDependency[] = [];
  const records = new Map<string, { uid: string }>();
  const attachmentNames = uniqueSorted(requirement.attachments);
  const taskRevisionNames = uniqueSorted(
    requirement.spec.productionItems.map((item) => item.taskSopRevision),
  );
  if (taskRevisionNames.some((name) => !name)) {
    throw new CanonicalDataError('Requirement production item must pin a TaskSop revision');
  }
  assertDependencyLookupLimit([
    { kind: DependencyKind.CUSTOMER, resourceName: requirement.spec.customer },
    ...attachmentNames.map((resourceName) => ({ kind: DependencyKind.ATTACHMENT, resourceName })),
    { kind: DependencyKind.ROBOT_MODEL_REVISION, resourceName: requirement.spec.robotModelRevision },
    ...taskRevisionNames.map((resourceName) => ({ kind: DependencyKind.TASK_SOP_REVISION, resourceName })),
  ]);

  const catalogs = catalogMap(await repository.getCatalogs([
    requirement.spec.customer,
    ...attachmentNames,
  ]));
  const customer = requireCatalog(catalogs, requirement.spec.customer, 'CUSTOMER', CustomerSchema);
  records.set(customer.record.name, customer.record);
  direct.push(catalogDirect(DependencyKind.CUSTOMER, customer.record));

  const attachments: Attachment[] = [];
  for (const name of attachmentNames) {
    const attachment = requireCatalog(catalogs, name, 'ATTACHMENT', AttachmentSchema);
    attachments.push(attachment.value);
    records.set(attachment.record.name, attachment.record);
    direct.push(catalogDirect(DependencyKind.ATTACHMENT, attachment.record));
  }

  const revisions = revisionMap(await repository.getRevisions([
    requirement.spec.robotModelRevision,
    ...taskRevisionNames,
  ]));
  const robot = requireRevision(
    revisions,
    requirement.spec.robotModelRevision,
    'ROBOT_MODEL_REVISION',
    RobotModelRevisionSchema,
  );
  records.set(robot.record.name, robot.record);
  direct.push(revisionUidDependency(DependencyKind.ROBOT_MODEL_REVISION, robot.record));

  const tasks: TaskSopRevision[] = [];
  for (const name of taskRevisionNames) {
    const task = requireRevision(revisions, name, 'TASK_SOP_REVISION', TaskSopRevisionSchema);
    tasks.push(task.value);
    records.set(task.record.name, task.record);
    direct.push(revisionUidDependency(DependencyKind.TASK_SOP_REVISION, task.record));
  }

  const normalized = dedupeDirect(direct);
  return {
    root,
    message: requirement,
    direct: normalized,
    reviewedWrites: toReviewedWrites(root.name, normalized, records, now),
    frozenDependencies: create(FrozenDependencyContextSchema, {
      customers: [customer.value],
      attachments,
    }),
    taskSopRevisions: tasks,
    robotModelRevisions: [robot.value],
  };
}

async function resolveRoot(
  repository: ResourceRepository,
  rootName: string,
  now = new Date().toISOString(),
): Promise<RootResolution> {
  const root = await repository.getCurrent(rootName);
  if (!root) throw new ResourceNotFoundError(rootName);
  if (root.archivedAt || root.lifecycle !== 'DRAFT') {
    throw new CanonicalDataError(`Only an active draft can resolve dependencies: ${rootName}`);
  }
  if (root.kind === 'TASK_SOP') {
    return resolveTaskDependencies(repository, root, fromDomainJsonString(TaskSopSchema, root.protoJson), now);
  }
  if (root.kind === 'REQUIREMENT') {
    return resolveRequirementDependencies(repository, root, fromDomainJsonString(RequirementSchema, root.protoJson), now);
  }
  throw new CanonicalDataError(`Resource is not an export root: ${rootName}`);
}

export async function reviewRootDependencies(
  repository: ResourceRepository,
  rootName: string,
): Promise<DependencyDiff> {
  const resolution = await resolveRoot(repository, rootName);
  const proposal = buildDependencyReviewProposal(rootName, resolution.root.etag, resolution.direct);
  return diffDependencies(proposal, reviewedAsDirect(await repository.loadReviewedDependencies(rootName)));
}

export async function acknowledgeRootDependencies(
  repository: ResourceRepository,
  input: { rootName: string; expectedEtag: string; proposalDigest: string },
): Promise<CurrentResourceRecord> {
  const resolution = await resolveRoot(repository, input.rootName);
  if (resolution.root.etag !== input.expectedEtag) {
    throw new ResourceConflictError(input.rootName, input.expectedEtag, resolution.root.etag);
  }
  const proposal = buildDependencyReviewProposal(input.rootName, input.expectedEtag, resolution.direct);
  const diff = diffDependencies(proposal, reviewedAsDirect(
    await repository.loadReviewedDependencies(input.rootName),
  ));
  if (diff.digest !== input.proposalDigest) throw new DependencyReviewRequiredError(diff);
  try {
    return await repository.replaceReviewedDependencies(
      input.rootName,
      input.expectedEtag,
      input.proposalDigest,
      resolution.reviewedWrites,
    );
  } catch (error) {
    if (!isDependencyCommitRace(error)) throw error;
    throw new DependencyReviewRequiredError(await reviewRootDependencies(repository, input.rootName));
  }
}

function safeSequence(value: bigint | undefined): number {
  if (value === undefined || value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CanonicalDataError('Candidate version sequence is missing or outside the safe integer range');
  }
  return Number(value);
}

function rootSourceId(value: { name: string; sourceId?: string }): string {
  return value.sourceId ?? value.name.split('/').at(-1)!;
}

export async function confirmRoot(
  repository: ResourceRepository,
  input: { rootName: string; expectedEtag: string; commandId?: string; now?: Date },
): Promise<AtomicConfirmationResult> {
  const now = input.now ?? new Date();
  const existingRoot = await repository.getCurrent(input.rootName);
  if (!existingRoot) throw new ResourceNotFoundError(input.rootName);
  if (existingRoot.lifecycle === 'CONFIRMED' && existingRoot.currentRevisionName) {
    const [revision, bundle] = await Promise.all([
      repository.getRevision(existingRoot.currentRevisionName),
      repository.getExportBundle(existingRoot.currentRevisionName),
    ]);
    if (!revision || !bundle || !revision.exportEligible || revision.ownerName !== existingRoot.name) {
      throw new CanonicalDataError(`Confirmed root is missing its immutable revision or bundle: ${input.rootName}`);
    }
    const retryCommandId = input.commandId ?? deterministicUid(
      'confirmationCommand',
      `${existingRoot.uid}:${revision.name}`,
    );
    if (revision.confirmationCommandId !== retryCommandId || revision.confirmedFromEtag !== input.expectedEtag) {
      throw new ResourceConflictError(input.rootName, input.expectedEtag, existingRoot.etag);
    }
    return { root: existingRoot, revision, bundle, idempotent: true };
  }
  const resolution = await resolveRoot(repository, input.rootName, now.toISOString());
  if (resolution.root.etag !== input.expectedEtag) {
    throw new ResourceConflictError(input.rootName, input.expectedEtag, resolution.root.etag);
  }
  const proposal = buildDependencyReviewProposal(input.rootName, input.expectedEtag, resolution.direct);
  const reviewed = await repository.loadReviewedDependencies(input.rootName);
  const diff = diffDependencies(proposal, reviewedAsDirect(reviewed));
  if (!resolution.root.reviewedManifestDigest || !diff.empty) throw new DependencyReviewRequiredError(diff);

  const sequence = safeSequence(
    resolution.message.$typeName.endsWith('TaskSop')
      ? (resolution.message as TaskSop).candidateVersionSequence
      : (resolution.message as Requirement).candidateVersionSequence,
  );
  const built = resolution.message.$typeName.endsWith('TaskSop')
    ? buildTaskSopConfirmation(resolution.message as TaskSop, resolution.frozenDependencies, now)
    : buildRequirementConfirmation(resolution.message as Requirement, resolution.frozenDependencies, now);

  if (built.current.$typeName.endsWith('TaskSop')) {
    assertValidDomainMessage(TaskSopSchema, built.current as TaskSop);
    assertValidDomainMessage(TaskSopRevisionSchema, built.revision as TaskSopRevision);
  } else {
    assertValidDomainMessage(RequirementSchema, built.current as Requirement);
    assertValidDomainMessage(RequirementRevisionSchema, built.revision as RequirementRevision);
  }

  const rootRevision = built.revision;
  const bundle = buildExportBundle(resolveExportClosure({
    requirementRevisions: rootRevision.$typeName.endsWith('RequirementRevision')
      ? [rootRevision as RequirementRevision]
      : [],
    taskSopRevisions: [
      ...(rootRevision.$typeName.endsWith('TaskSopRevision') ? [rootRevision as TaskSopRevision] : []),
      ...resolution.taskSopRevisions,
    ],
    robotModelRevisions: resolution.robotModelRevisions,
  }, {
    kind: rootRevision.$typeName.endsWith('TaskSopRevision') ? 'task_sop' : 'requirement',
    sourceId: rootSourceId(rootRevision.snapshot!),
    versionLabel: rootRevision.versionLabel,
  }));
  const bundleProtoJson = encodeExportBundle(bundle);
  const revisionProtoJson = rootRevision.$typeName.endsWith('TaskSopRevision')
    ? protoJson(TaskSopRevisionSchema, rootRevision as TaskSopRevision)
    : protoJson(RequirementRevisionSchema, rootRevision as RequirementRevision);

  try {
    return await repository.confirm({
      commandId: input.commandId ?? deterministicUid('confirmationCommand', `${resolution.root.uid}:${rootRevision.name}`),
      rootName: input.rootName,
      expectedEtag: input.expectedEtag,
      reviewedManifestDigest: resolution.root.reviewedManifestDigest,
      confirmedRoot: {
        protoSchema: built.current.$typeName,
        protoJson: built.current.$typeName.endsWith('TaskSop')
          ? protoJson(TaskSopSchema, built.current as TaskSop)
          : protoJson(RequirementSchema, built.current as Requirement),
        now: now.toISOString(),
      },
      revision: {
        protoSchema: rootRevision.$typeName,
        revisionProtoJson,
        versionSequence: sequence,
        revisionOrigin: 'RUNTIME_CONFIRMED',
        lifecycle: 'CONFIRMED',
        exportEligible: true,
        frozenDependenciesProtoJson: protoJson(FrozenDependencyContextSchema, resolution.frozenDependencies),
        now: now.toISOString(),
      },
      bundle: {
        protoSchema: bundle.$typeName,
        bundleProtoJson,
        rootRevisionName: rootRevision.name,
        rootKind: rootRevision.$typeName.endsWith('TaskSopRevision') ? 'TASK_SOP' : 'REQUIREMENT',
        schemaVersion: bundle.schemaVersion,
        rendererVersion: bundle.content!.rendererVersion,
        contentSizeBytes: Number(bundle.contentSizeBytes),
        contentSha256: bundle.contentSha256,
        now: now.toISOString(),
      },
    });
  } catch (error) {
    if (!isDependencyCommitRace(error)) throw error;
    throw new DependencyReviewRequiredError(await reviewRootDependencies(repository, input.rootName));
  }
}
