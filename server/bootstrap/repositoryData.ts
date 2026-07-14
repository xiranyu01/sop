import { create, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import {
  AttachmentSchema,
  CustomerSchema,
  FrozenDependencyContextSchema,
  GlobalFieldSchema,
  MaterialSchema,
  MaterialStateRuleSchema,
  RobotModelRevisionSchema,
  RobotModelSchema,
  SceneSchema,
} from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { Lifecycle, RevisionOrigin } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { RequirementRevisionSchema, RequirementSchema } from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import { TaskSopRevisionSchema, TaskSopSchema } from '../../gen/coscene/sop/v1alpha1/task_sop_pb';
import type {
  CurrentResourceWriteInput,
  ExportBundleWriteInput,
  ResourceWriteInput,
  RevisionWriteInput,
} from '../domain/repository';
import { stableHash, stableJson } from '../domain/identity';
import { encodeExportBundle } from '../export/codec';
import { buildExportBundle } from '../export/bundle';
import { resolveExportClosure } from '../export/closure';
import { toDomainJson } from '../../shared/domain/codec';
import type { AppData } from '../../shared/transport/restDto';
import { convertLegacyToV1alpha1 } from './legacyToV1alpha1';

// Compatibility export for callers created while the bootstrap work was in
// flight. Runtime code should import the marker helper from `./status` so it
// does not pull in fixture conversion code.
export { repositoryBootstrapMarkerValue as bootstrapMarkerValue } from './status';

export const repositorySchemaVersion = 'resource-storage-v1' as const;
export const repositoryBootstrapVersion = 'repository-fixtures-v1' as const;

export type PreparedResourceWrite<T extends ResourceWriteInput = ResourceWriteInput> = T & { name: string };
export type PreparedRevisionWrite = RevisionWriteInput & { name: string; ownerName: string; versionLabel: string };

export type PreparedRepositoryData = {
  schemaVersion: typeof repositorySchemaVersion;
  bootstrapVersion: typeof repositoryBootstrapVersion;
  datasetDigest: string;
  catalogs: PreparedResourceWrite[];
  currents: PreparedResourceWrite<CurrentResourceWriteInput>[];
  revisions: PreparedRevisionWrite[];
  bundles: ExportBundleWriteInput[];
  expectedCounts: { catalogs: number; currents: number; revisions: number; bundles: number };
};

function protoJson<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): string {
  return JSON.stringify(toDomainJson(schema, message));
}

function seconds(value?: { seconds: bigint; nanos: number }): bigint {
  return value ? value.seconds * 1_000_000_000n + BigInt(value.nanos) : 0n;
}

function versionParts(value: string): number[] {
  return value.split('.').map((part) => Number(part));
}

function compareHistory(
  left: { versionLabel: string; sourceVersionId?: string; createTime?: { seconds: bigint; nanos: number } },
  right: { versionLabel: string; sourceVersionId?: string; createTime?: { seconds: bigint; nanos: number } },
): number {
  const leftVersion = versionParts(left.versionLabel);
  const rightVersion = versionParts(right.versionLabel);
  for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index += 1) {
    const compared = (leftVersion[index] ?? 0) - (rightVersion[index] ?? 0);
    if (compared) return compared;
  }
  const time = seconds(left.createTime) - seconds(right.createTime);
  if (time) return time < 0n ? -1 : 1;
  return (left.sourceVersionId ?? left.versionLabel).localeCompare(right.sourceVersionId ?? right.versionLabel, 'en');
}

function revisionSequence(history: Array<{ name: string }>, name: string): number {
  const index = history.findIndex((item) => item.name === name);
  if (index < 0) throw new TypeError(`Revision sequence not found: ${name}`);
  return index + 1;
}

function candidateLabelAfter(versionLabel?: string): string {
  if (!versionLabel) return '1.0.0';
  const [major, minor, patch] = versionParts(versionLabel);
  return `${major ?? 0}.${minor ?? 0}.${(patch ?? 0) + 1}`;
}

export function prepareRepositoryData(data: AppData): PreparedRepositoryData {
  const datasetDigest = stableHash(stableJson(data));
  const conversion = convertLegacyToV1alpha1(data, datasetDigest);
  if (!conversion.report.ok) {
    throw new TypeError(`Repository fixture conversion failed: ${conversion.report.issues.map((issue) => `${issue.code}:${issue.owner}`).join(', ')}`);
  }
  const resources = conversion.resources;
  const catalogs: PreparedResourceWrite[] = [];
  const addCatalogs = <Desc extends DescMessage>(schema: Desc, values: MessageShape<Desc>[]) => {
    for (const value of values) catalogs.push({ name: (value as unknown as { name: string }).name, protoSchema: schema.typeName, protoJson: protoJson(schema, value) });
  };
  addCatalogs(CustomerSchema, resources.customers);
  addCatalogs(MaterialSchema, resources.materials);
  addCatalogs(SceneSchema, resources.scenes);
  addCatalogs(GlobalFieldSchema, resources.globalFields);
  addCatalogs(MaterialStateRuleSchema, resources.materialStateRules);
  addCatalogs(AttachmentSchema, resources.attachments);

  const currents: PreparedResourceWrite<CurrentResourceWriteInput>[] = [];
  const revisions: PreparedRevisionWrite[] = [];
  const bundles: ExportBundleWriteInput[] = [];

  const addRevision = <Desc extends DescMessage>(
    schema: Desc,
    revision: MessageShape<Desc> & {
      name: string;
      uid: string;
      snapshot?: { name: string };
      versionLabel: string;
      sourceVersionId?: string;
      frozenDependencies?: unknown;
      origin?: RevisionOrigin;
      exportEligible?: boolean;
    },
    sequence: number,
  ) => {
    if (!revision.snapshot) throw new TypeError(`Revision snapshot missing: ${revision.name}`);
    revisions.push({
      name: revision.name,
      ownerName: revision.snapshot.name,
      versionLabel: revision.versionLabel,
      protoSchema: schema.typeName,
      revisionProtoJson: protoJson(schema, revision),
      versionSequence: sequence,
      revisionOrigin: revision.origin === RevisionOrigin.IMPORTED_DRAFT_CHECKPOINT
        ? 'IMPORTED_DRAFT_CHECKPOINT'
        : revision.origin === RevisionOrigin.IMPORTED_CONFIRMED ? 'IMPORTED_CONFIRMED' : 'RUNTIME_CONFIRMED',
      lifecycle: revision.origin === RevisionOrigin.IMPORTED_DRAFT_CHECKPOINT ? 'DRAFT' : 'CONFIRMED',
      exportEligible: Boolean(revision.exportEligible),
      frozenDependenciesProtoJson: revision.frozenDependencies === undefined
        ? undefined
        : JSON.stringify(toDomainJson(FrozenDependencyContextSchema, revision.frozenDependencies as never)),
    });
  };

  for (const robot of resources.robotModels) {
    currents.push({ name: robot.name, protoSchema: RobotModelSchema.typeName, protoJson: protoJson(RobotModelSchema, robot) });
    const history = resources.robotModelRevisions.filter((item) => item.snapshot?.name === robot.name).sort(compareHistory);
    for (const revision of history) addRevision(RobotModelRevisionSchema, revision, revisionSequence(history, revision.name));
  }

  for (const taskName of new Set(resources.taskSopRevisions.map((item) => item.snapshot?.name).filter((name): name is string => Boolean(name)))) {
    const history = resources.taskSopRevisions.filter((item) => item.snapshot?.name === taskName).sort(compareHistory);
    const drafts = history.filter((item) => item.origin === RevisionOrigin.IMPORTED_DRAFT_CHECKPOINT);
    const editableDraft = drafts.at(-1);
    const confirmed = history.filter((item) => item.origin === RevisionOrigin.IMPORTED_CONFIRMED);
    const latestConfirmed = confirmed.at(-1);
    const source = editableDraft?.snapshot ?? latestConfirmed?.snapshot;
    if (!source) throw new TypeError(`TaskSop has no current source: ${taskName}`);
    const current = create(TaskSopSchema, {
      ...source,
      currentRevision: latestConfirmed?.name ?? '',
      lifecycle: editableDraft ? Lifecycle.DRAFT : Lifecycle.CONFIRMED,
      candidateVersionSequence: editableDraft ? BigInt(revisionSequence(history, editableDraft.name)) : undefined,
      candidateVersionLabel: editableDraft?.versionLabel,
      candidateSourceVersionId: editableDraft?.sourceVersionId,
      reviewedDependencyDigest: undefined,
    });
    currents.push({
      name: current.name,
      protoSchema: TaskSopSchema.typeName,
      protoJson: protoJson(TaskSopSchema, current),
      candidateVersionSequence: editableDraft ? revisionSequence(history, editableDraft.name) : undefined,
      candidateVersionLabel: editableDraft?.versionLabel,
    });
    for (const revision of history) {
      if (revision.name === editableDraft?.name) continue;
      const stored = revision.origin === RevisionOrigin.IMPORTED_DRAFT_CHECKPOINT && revision.snapshot
        ? create(TaskSopRevisionSchema, {
          ...revision,
          snapshot: { ...revision.snapshot, currentRevision: latestConfirmed?.name ?? '' },
        })
        : revision;
      addRevision(TaskSopRevisionSchema, stored, revisionSequence(history, revision.name));
    }
  }

  for (const requirementName of new Set(resources.requirementRevisions.map((item) => item.snapshot?.name).filter((name): name is string => Boolean(name)))) {
    const history = resources.requirementRevisions.filter((item) => item.snapshot?.name === requirementName).sort(compareHistory);
    const drafts = history.filter((item) => item.origin === RevisionOrigin.IMPORTED_DRAFT_CHECKPOINT);
    if (drafts.length > 1) throw new TypeError(`Multiple legacy Requirement drafts are unsupported: ${requirementName}`);
    const editableDraft = drafts.at(-1);
    const confirmed = history.filter((item) => item.origin === RevisionOrigin.IMPORTED_CONFIRMED);
    const latestConfirmed = confirmed.at(-1);
    const source = editableDraft?.snapshot ?? latestConfirmed?.snapshot;
    if (!source) throw new TypeError(`Requirement has no current source: ${requirementName}`);
    const current = create(RequirementSchema, {
      ...source,
      currentRevision: latestConfirmed?.name ?? '',
      lifecycle: editableDraft ? Lifecycle.DRAFT : Lifecycle.CONFIRMED,
      candidateVersionSequence: editableDraft ? BigInt(revisionSequence(history, editableDraft.name)) : undefined,
      candidateVersionLabel: editableDraft?.versionLabel,
      candidateSourceVersionId: editableDraft?.sourceVersionId,
      reviewedDependencyDigest: undefined,
    });
    currents.push({
      name: current.name,
      protoSchema: RequirementSchema.typeName,
      protoJson: protoJson(RequirementSchema, current),
      candidateVersionSequence: editableDraft ? revisionSequence(history, editableDraft.name) : undefined,
      candidateVersionLabel: editableDraft?.versionLabel,
    });
    for (const revision of confirmed) addRevision(RequirementRevisionSchema, revision, revisionSequence(history, revision.name));
  }

  for (const revision of [
    ...resources.taskSopRevisions.filter((item) => item.origin === RevisionOrigin.IMPORTED_CONFIRMED),
    ...resources.requirementRevisions.filter((item) => item.origin === RevisionOrigin.IMPORTED_CONFIRMED),
  ]) {
    const root = revision.$typeName.endsWith('TaskSopRevision')
      ? { kind: 'task_sop' as const, sourceId: revision.snapshot!.sourceId ?? revision.snapshot!.name.split('/').at(-1)!, versionLabel: revision.versionLabel }
      : { kind: 'requirement' as const, sourceId: revision.snapshot!.sourceId ?? revision.snapshot!.name.split('/').at(-1)!, versionLabel: revision.versionLabel };
    const bundle = buildExportBundle(resolveExportClosure(resources, root));
    bundles.push({
      protoSchema: bundle.$typeName,
      bundleProtoJson: encodeExportBundle(bundle),
      rootRevisionName: bundle.content!.revisionName,
      rootKind: root.kind === 'task_sop' ? 'TASK_SOP' : 'REQUIREMENT',
      schemaVersion: bundle.schemaVersion,
      rendererVersion: bundle.content!.rendererVersion,
      contentSizeBytes: Number(bundle.contentSizeBytes),
      contentSha256: bundle.contentSha256,
    });
  }

  catalogs.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  currents.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  revisions.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  bundles.sort((left, right) => left.rootRevisionName.localeCompare(right.rootRevisionName, 'en'));
  return {
    schemaVersion: repositorySchemaVersion,
    bootstrapVersion: repositoryBootstrapVersion,
    datasetDigest,
    catalogs,
    currents,
    revisions,
    bundles,
    expectedCounts: { catalogs: catalogs.length, currents: currents.length, revisions: revisions.length, bundles: bundles.length },
  };
}

export function nextCandidateVersionAfter(versionLabel?: string): string {
  return candidateLabelAfter(versionLabel);
}
