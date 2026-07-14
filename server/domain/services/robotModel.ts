import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  RobotModelRevisionSchema,
  RobotModelSchema,
  type RobotModel,
  type RobotModelRevision,
} from '../../../gen/coscene/sop/v1alpha1/catalog_pb';
import { fromDomainJsonString, toDomainJson } from '../../../shared/domain/codec';
import { assertValidDomainMessage } from '../../../shared/domain/validation';
import type { AtomicRobotModelSaveResult, ResourceRepository } from '../repository';
import { ResourceConflictError, ResourceNotFoundError } from '../repository';
import { CanonicalDataError } from '../errors';
import { appendRobotModelRevision } from './versioning';

function protoJson(value: RobotModel | RobotModelRevision): string {
  const schema = value.$typeName.endsWith('Revision') ? RobotModelRevisionSchema : RobotModelSchema;
  return JSON.stringify(toDomainJson(schema, value as never));
}

type JsonObject = Record<string, unknown>;

function parseProtoJsonObject(value: string, label: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CanonicalDataError(`${label} ProtoJSON must be an object`);
  }
  return parsed as JsonObject;
}

function rawField(value: JsonObject, camelCase: string, snakeCase = camelCase): unknown {
  return value[camelCase] ?? value[snakeCase];
}

function replaceField(
  value: JsonObject,
  camelCase: string,
  snakeCase: string,
  authoritative: unknown,
): void {
  delete value[camelCase];
  if (snakeCase !== camelCase) delete value[snakeCase];
  if (authoritative !== undefined && authoritative !== null) value[camelCase] = authoritative;
}

function authoritativeRobotModelUpdate(
  requestedProtoJson: string,
  storedProtoJson: string,
  now: Date,
): RobotModel {
  const requested = { ...parseProtoJsonObject(requestedProtoJson, 'requested RobotModel') };
  const authoritative = parseProtoJsonObject(storedProtoJson, 'stored RobotModel');
  for (const [camelCase, snakeCase] of [
    ['name', 'name'],
    ['uid', 'uid'],
    ['sourceId', 'source_id'],
    ['currentRevision', 'current_revision'],
    ['createTime', 'create_time'],
    ['etag', 'etag'],
  ] as const) {
    replaceField(requested, camelCase, snakeCase, rawField(authoritative, camelCase, snakeCase));
  }
  replaceField(requested, 'updateTime', 'update_time', now.toISOString());
  return fromDomainJsonString(RobotModelSchema, JSON.stringify(requested));
}

export async function createRobotModel(
  repository: ResourceRepository,
  input: { resourceProtoJson: string; now?: Date },
): Promise<AtomicRobotModelSaveResult> {
  const requested = fromDomainJsonString(RobotModelSchema, input.resourceProtoJson);
  if (requested.currentRevision) {
    throw new CanonicalDataError('A new RobotModel cannot supply a current revision');
  }
  const now = input.now ?? new Date();
  const built = appendRobotModelRevision(create(RobotModelSchema, {
    ...requested,
    createTime: timestampFromDate(now),
    updateTime: timestampFromDate(now),
    currentRevision: '',
    etag: '',
  }), undefined, 1, now);
  assertValidDomainMessage(RobotModelSchema, built.current);
  assertValidDomainMessage(RobotModelRevisionSchema, built.revision);
  return repository.createRobotModel({
    current: {
      protoSchema: RobotModelSchema.typeName,
      protoJson: protoJson(built.current),
      now: now.toISOString(),
    },
    revision: {
      protoSchema: RobotModelRevisionSchema.typeName,
      revisionProtoJson: protoJson(built.revision),
      versionSequence: built.versionSequence,
      revisionOrigin: 'RUNTIME_CONFIRMED',
      lifecycle: 'CONFIRMED',
      exportEligible: false,
      now: now.toISOString(),
    },
  });
}

export async function saveRobotModel(
  repository: ResourceRepository,
  input: { rootName: string; expectedEtag: string; resourceProtoJson: string; now?: Date },
): Promise<AtomicRobotModelSaveResult> {
  const stored = await repository.getCurrent(input.rootName);
  if (!stored) throw new ResourceNotFoundError(input.rootName);
  if (stored.kind !== 'ROBOT_MODEL' || stored.lifecycle !== 'ACTIVE') {
    throw new CanonicalDataError(`Resource is not an active RobotModel: ${input.rootName}`);
  }
  if (stored.etag !== input.expectedEtag) {
    throw new ResourceConflictError(input.rootName, input.expectedEtag, stored.etag);
  }
  const now = input.now ?? new Date();
  const authoritative = fromDomainJsonString(RobotModelSchema, stored.protoJson);
  const requested = authoritativeRobotModelUpdate(input.resourceProtoJson, stored.protoJson, now);
  const candidate = create(RobotModelSchema, {
    ...requested,
    name: authoritative.name,
    uid: authoritative.uid,
    sourceId: authoritative.sourceId,
    currentRevision: authoritative.currentRevision,
    createTime: authoritative.createTime,
    etag: authoritative.etag,
  });
  const previousRecord = authoritative.currentRevision
    ? await repository.getRevision(authoritative.currentRevision)
    : undefined;
  if (authoritative.currentRevision && (!previousRecord || previousRecord.kind !== 'ROBOT_MODEL_REVISION')) {
    throw new CanonicalDataError(`RobotModel current revision is missing: ${authoritative.currentRevision}`);
  }
  const previous = previousRecord
    ? fromDomainJsonString(RobotModelRevisionSchema, previousRecord.revisionProtoJson)
    : undefined;
  const built = appendRobotModelRevision(candidate, previous, (previousRecord?.versionSequence ?? 0) + 1, now);
  assertValidDomainMessage(RobotModelSchema, built.current);
  assertValidDomainMessage(RobotModelRevisionSchema, built.revision);
  return repository.saveRobotModel({
    rootName: input.rootName,
    expectedEtag: input.expectedEtag,
    current: {
      protoSchema: RobotModelSchema.typeName,
      protoJson: protoJson(built.current),
      now: now.toISOString(),
    },
    revision: {
      protoSchema: RobotModelRevisionSchema.typeName,
      revisionProtoJson: protoJson(built.revision),
      versionSequence: built.versionSequence,
      revisionOrigin: 'RUNTIME_CONFIRMED',
      lifecycle: 'CONFIRMED',
      exportEligible: false,
      now: now.toISOString(),
    },
  });
}
