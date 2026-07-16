import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  FrozenDependencyContextSchema,
  RobotModelRevisionSchema,
  RobotModelSchema,
  type FrozenDependencyContext,
  type RobotModel,
  type RobotModelRevision,
} from '../../../gen/coscene/sop/v1alpha1/catalog_pb';
import { Lifecycle, RevisionOrigin } from '../../../gen/coscene/sop/v1alpha1/common_pb';
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
import { deterministicUid, revisionName } from '../identity';
import { CanonicalDataError } from '../errors';

function nextPatchVersion(value: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new CanonicalDataError(`Invalid semantic version: ${value}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function assertConfirmedBase(
  currentName: string,
  revision: TaskSopRevision | RequirementRevision,
): void {
  if (!revision.snapshot || revision.snapshot.name !== currentName) throw new CanonicalDataError('Selected base revision belongs to another resource');
  if (![
    RevisionOrigin.RUNTIME_CONFIRMED,
    RevisionOrigin.IMPORTED_CONFIRMED,
  ].includes(revision.origin) || !revision.exportEligible || revision.snapshot.lifecycle !== Lifecycle.CONFIRMED) {
    throw new CanonicalDataError(`Revision cannot be used as a draft base: ${revision.name}`);
  }
}

export function startNextTaskSopDraft(
  current: TaskSop,
  base: TaskSopRevision,
  nextSequence: bigint,
  now = new Date(),
): TaskSop {
  assertConfirmedBase(current.name, base);
  const candidateVersionLabel = nextPatchVersion(base.versionLabel);
  return create(TaskSopSchema, {
    ...base.snapshot!,
    name: current.name,
    uid: current.uid,
    sourceId: current.sourceId,
    lifecycle: Lifecycle.DRAFT,
    currentRevision: base.name,
    candidateVersionSequence: nextSequence,
    candidateVersionLabel,
    candidateSourceVersionId: undefined,
    candidateCreateTime: timestampFromDate(now),
    reviewedDependencyDigest: undefined,
    createTime: current.createTime,
    updateTime: timestampFromDate(now),
    etag: '',
  });
}

export function startNextRequirementDraft(
  current: Requirement,
  base: RequirementRevision,
  nextSequence: bigint,
  now = new Date(),
): Requirement {
  assertConfirmedBase(current.name, base);
  const candidateVersionLabel = nextPatchVersion(base.versionLabel);
  return create(RequirementSchema, {
    ...base.snapshot!,
    name: current.name,
    uid: current.uid,
    sourceId: current.sourceId,
    lifecycle: Lifecycle.DRAFT,
    currentRevision: base.name,
    candidateVersionSequence: nextSequence,
    candidateVersionLabel,
    candidateSourceVersionId: undefined,
    candidateCreateTime: timestampFromDate(now),
    reviewedDependencyDigest: undefined,
    createTime: current.createTime,
    updateTime: timestampFromDate(now),
    etag: '',
  });
}

function confirmedTaskSnapshot(draft: TaskSop, revision: string, now: Date): TaskSop {
  return create(TaskSopSchema, {
    ...draft,
    lifecycle: Lifecycle.CONFIRMED,
    currentRevision: revision,
    candidateVersionSequence: undefined,
    candidateVersionLabel: undefined,
    candidateSourceVersionId: undefined,
    candidateCreateTime: undefined,
    updateTime: timestampFromDate(now),
    etag: '',
  });
}

function confirmedRequirementSnapshot(draft: Requirement, revision: string, now: Date): Requirement {
  return create(RequirementSchema, {
    ...draft,
    lifecycle: Lifecycle.CONFIRMED,
    currentRevision: revision,
    candidateVersionSequence: undefined,
    candidateVersionLabel: undefined,
    candidateSourceVersionId: undefined,
    candidateCreateTime: undefined,
    updateTime: timestampFromDate(now),
    etag: '',
  });
}

export function buildTaskSopConfirmation(
  draft: TaskSop,
  frozenDependencies: FrozenDependencyContext,
  now = new Date(),
): { current: TaskSop; revision: TaskSopRevision } {
  if (draft.lifecycle !== Lifecycle.DRAFT || !draft.candidateVersionLabel || draft.candidateVersionSequence === undefined) {
    throw new CanonicalDataError('TaskSop confirmation requires a versioned current draft');
  }
  const name = revisionName(draft.name, draft.candidateVersionLabel);
  const current = confirmedTaskSnapshot(draft, name, now);
  const revision = create(TaskSopRevisionSchema, {
    name,
    uid: deterministicUid('taskSopRevision', `${draft.uid}:${draft.candidateVersionLabel}`),
    snapshot: current,
    previousRevision: draft.currentRevision || undefined,
    versionLabel: draft.candidateVersionLabel,
    createTime: draft.candidateCreateTime ?? timestampFromDate(now),
    frozenDependencies: create(FrozenDependencyContextSchema, frozenDependencies),
    origin: RevisionOrigin.RUNTIME_CONFIRMED,
    exportEligible: true,
  });
  return { current, revision };
}

export function buildRequirementConfirmation(
  draft: Requirement,
  frozenDependencies: FrozenDependencyContext,
  now = new Date(),
): { current: Requirement; revision: RequirementRevision } {
  if (draft.lifecycle !== Lifecycle.DRAFT || !draft.candidateVersionLabel || draft.candidateVersionSequence === undefined) {
    throw new CanonicalDataError('Requirement confirmation requires a versioned current draft');
  }
  const name = revisionName(draft.name, draft.candidateVersionLabel);
  const current = confirmedRequirementSnapshot(draft, name, now);
  const revision = create(RequirementRevisionSchema, {
    name,
    uid: deterministicUid('requirementRevision', `${draft.uid}:${draft.candidateVersionLabel}`),
    snapshot: current,
    previousRevision: draft.currentRevision || undefined,
    versionLabel: draft.candidateVersionLabel,
    createTime: draft.candidateCreateTime ?? timestampFromDate(now),
    frozenDependencies: create(FrozenDependencyContextSchema, frozenDependencies),
    origin: RevisionOrigin.RUNTIME_CONFIRMED,
    exportEligible: true,
  });
  return { current, revision };
}

export function appendRobotModelRevision(
  current: RobotModel,
  previous: RobotModelRevision | undefined,
  nextSequence: number,
  now = new Date(),
): { current: RobotModel; revision: RobotModelRevision; versionSequence: number } {
  if (previous?.snapshot?.name && previous.snapshot.name !== current.name) {
    throw new CanonicalDataError('RobotModel previous revision belongs to another resource');
  }
  if (!Number.isSafeInteger(nextSequence) || nextSequence < 1 || (previous ? nextSequence < 2 : nextSequence !== 1)) {
    throw new CanonicalDataError(`Invalid RobotModel revision sequence: ${nextSequence}`);
  }
  const versionLabel = previous ? nextPatchVersion(previous.versionLabel) : '1.0.0';
  const name = revisionName(current.name, versionLabel);
  const updated = create(RobotModelSchema, {
    ...current,
    currentRevision: name,
    updateTime: timestampFromDate(now),
    etag: '',
  });
  return {
    current: updated,
    revision: create(RobotModelRevisionSchema, {
      name,
      uid: deterministicUid('robotModelRevision', `${current.uid}:${versionLabel}`),
      snapshot: updated,
      previousRevision: previous?.name,
      versionLabel,
      createTime: timestampFromDate(now),
    }),
    versionSequence: nextSequence,
  };
}
