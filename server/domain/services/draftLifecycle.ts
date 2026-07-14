import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Lifecycle } from '../../../gen/coscene/sop/v1alpha1/common_pb';
import {
  TaskSopRevisionSchema,
  TaskSopSchema,
} from '../../../gen/coscene/sop/v1alpha1/task_sop_pb';
import { RequirementRevisionSchema, RequirementSchema } from '../../../gen/coscene/sop/v1alpha1/requirement_pb';
import { fromDomainJsonString, toDomainJson } from '../../../shared/domain/codec';
import { assertValidDomainMessage } from '../../../shared/domain/validation';
import type { CurrentResourceRecord, ResourceRepository } from '../repository';
import { ResourceConflictError, ResourceNotFoundError } from '../repository';
import { CanonicalDataError } from '../errors';
import { startNextRequirementDraft, startNextTaskSopDraft } from './versioning';

export async function startNextDraft(
  repository: ResourceRepository,
  input: { rootName: string; expectedEtag: string; now?: Date },
): Promise<CurrentResourceRecord> {
  const current = await repository.getCurrent(input.rootName);
  if (!current) throw new ResourceNotFoundError(input.rootName);
  if (current.etag !== input.expectedEtag) {
    throw new ResourceConflictError(input.rootName, input.expectedEtag, current.etag);
  }
  if ((current.kind !== 'TASK_SOP' && current.kind !== 'REQUIREMENT') ||
    current.lifecycle !== 'CONFIRMED' || !current.currentRevisionName) {
    throw new CanonicalDataError('Starting the next draft requires a confirmed TaskSop or Requirement');
  }
  const base = await repository.getRevision(current.currentRevisionName);
  if (!base || !base.exportEligible || base.lifecycle !== 'CONFIRMED' || base.ownerName !== current.name) {
    throw new CanonicalDataError(`Current revision cannot be used as a draft base: ${current.currentRevisionName}`);
  }
  const now = input.now ?? new Date();
  if (current.kind === 'TASK_SOP') {
    const draft = startNextTaskSopDraft(
      fromDomainJsonString(TaskSopSchema, current.protoJson),
      fromDomainJsonString(TaskSopRevisionSchema, base.revisionProtoJson),
      BigInt(base.versionSequence + 1),
      now,
    );
    assertValidDomainMessage(TaskSopSchema, draft);
    return repository.updateCurrent(current.name, input.expectedEtag, {
      protoSchema: TaskSopSchema.typeName,
      protoJson: JSON.stringify(toDomainJson(TaskSopSchema, draft)),
      candidateVersionSequence: base.versionSequence + 1,
      candidateVersionLabel: draft.candidateVersionLabel,
      now: now.toISOString(),
    });
  }
  const draft = startNextRequirementDraft(
    fromDomainJsonString(RequirementSchema, current.protoJson),
    fromDomainJsonString(RequirementRevisionSchema, base.revisionProtoJson),
    BigInt(base.versionSequence + 1),
    now,
  );
  assertValidDomainMessage(RequirementSchema, draft);
  return repository.updateCurrent(current.name, input.expectedEtag, {
    protoSchema: RequirementSchema.typeName,
    protoJson: JSON.stringify(toDomainJson(RequirementSchema, draft)),
    candidateVersionSequence: base.versionSequence + 1,
    candidateVersionLabel: draft.candidateVersionLabel,
    now: now.toISOString(),
  });
}

/**
 * Discards only the mutable current draft. Immutable imported checkpoints and
 * confirmed revisions are history and are never deleted by this transition.
 *
 * A draft based on a confirmed revision is restored to that exact confirmed
 * snapshot. An initial draft has no confirmed state to restore, so it is soft
 * archived and disappears from active resource pages.
 */
export async function discardDraft(
  repository: ResourceRepository,
  input: { rootName: string; expectedEtag: string; now?: Date },
): Promise<CurrentResourceRecord> {
  const current = await repository.getCurrent(input.rootName);
  if (!current) throw new ResourceNotFoundError(input.rootName);
  if (current.etag !== input.expectedEtag) {
    throw new ResourceConflictError(input.rootName, input.expectedEtag, current.etag);
  }
  if ((current.kind !== 'TASK_SOP' && current.kind !== 'REQUIREMENT') ||
    current.lifecycle !== 'DRAFT' || current.archivedAt) {
    throw new CanonicalDataError('Discarding a draft requires an active TaskSop or Requirement draft');
  }

  const now = input.now ?? new Date();
  if (!current.currentRevisionName) {
    const archived = current.kind === 'TASK_SOP'
      ? create(TaskSopSchema, {
        ...fromDomainJsonString(TaskSopSchema, current.protoJson),
        lifecycle: Lifecycle.ARCHIVED,
        candidateVersionSequence: undefined,
        candidateVersionLabel: undefined,
        candidateSourceVersionId: undefined,
        reviewedDependencyDigest: undefined,
        updateTime: timestampFromDate(now),
        etag: '',
      })
      : create(RequirementSchema, {
        ...fromDomainJsonString(RequirementSchema, current.protoJson),
        lifecycle: Lifecycle.ARCHIVED,
        candidateVersionSequence: undefined,
        candidateVersionLabel: undefined,
        candidateSourceVersionId: undefined,
        reviewedDependencyDigest: undefined,
        updateTime: timestampFromDate(now),
        etag: '',
      });
    const schema = current.kind === 'TASK_SOP' ? TaskSopSchema : RequirementSchema;
    assertValidDomainMessage(schema, archived as never);
    return repository.archiveCurrent(current.name, input.expectedEtag, {
      protoSchema: schema.typeName,
      protoJson: JSON.stringify(toDomainJson(schema, archived as never)),
      now: now.toISOString(),
    });
  }

  const base = await repository.getRevision(current.currentRevisionName);
  if (!base || base.ownerName !== current.name || base.lifecycle !== 'CONFIRMED' ||
    !base.exportEligible || base.revisionOrigin === 'IMPORTED_DRAFT_CHECKPOINT') {
    throw new CanonicalDataError(`Current revision cannot restore a draft: ${current.currentRevisionName}`);
  }

  if (current.kind === 'TASK_SOP') {
    if (base.kind !== 'TASK_SOP_REVISION') {
      throw new CanonicalDataError(`Current revision kind does not match TaskSop: ${base.name}`);
    }
    const revision = fromDomainJsonString(TaskSopRevisionSchema, base.revisionProtoJson);
    if (!revision.snapshot || revision.snapshot.name !== current.name || revision.snapshot.uid !== current.uid) {
      throw new CanonicalDataError(`Current revision snapshot does not match TaskSop: ${base.name}`);
    }
    const restored = create(TaskSopSchema, {
      ...revision.snapshot,
      lifecycle: Lifecycle.CONFIRMED,
      currentRevision: base.name,
      candidateVersionSequence: undefined,
      candidateVersionLabel: undefined,
      candidateSourceVersionId: undefined,
      updateTime: timestampFromDate(now),
      etag: '',
    });
    assertValidDomainMessage(TaskSopSchema, restored);
    return repository.updateCurrent(current.name, input.expectedEtag, {
      protoSchema: TaskSopSchema.typeName,
      protoJson: JSON.stringify(toDomainJson(TaskSopSchema, restored)),
      now: now.toISOString(),
    });
  }

  if (base.kind !== 'REQUIREMENT_REVISION') {
    throw new CanonicalDataError(`Current revision kind does not match Requirement: ${base.name}`);
  }
  const revision = fromDomainJsonString(RequirementRevisionSchema, base.revisionProtoJson);
  if (!revision.snapshot || revision.snapshot.name !== current.name || revision.snapshot.uid !== current.uid) {
    throw new CanonicalDataError(`Current revision snapshot does not match Requirement: ${base.name}`);
  }
  const restored = create(RequirementSchema, {
    ...revision.snapshot,
    lifecycle: Lifecycle.CONFIRMED,
    currentRevision: base.name,
    candidateVersionSequence: undefined,
    candidateVersionLabel: undefined,
    candidateSourceVersionId: undefined,
    updateTime: timestampFromDate(now),
    etag: '',
  });
  assertValidDomainMessage(RequirementSchema, restored);
  return repository.updateCurrent(current.name, input.expectedEtag, {
    protoSchema: RequirementSchema.typeName,
    protoJson: JSON.stringify(toDomainJson(RequirementSchema, restored)),
    now: now.toISOString(),
  });
}
