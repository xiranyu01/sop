import { create } from '@bufbuild/protobuf';
import { RobotModelSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { Lifecycle } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { RequirementSchema } from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import { TaskSopSchema } from '../../gen/coscene/sop/v1alpha1/task_sop_pb';
import { fromDomainJsonString, toDomainJson } from '../../shared/domain/codec';
import { stableJson } from '../domain/identity';
import type {
  CatalogResourceRecord,
  CurrentResourceRecord,
  CurrentResourceWriteInput,
  ExportBundleRecord,
  ResourceRepository,
  RevisionRecord,
} from '../domain/repository';
import { nextCandidateVersionAfter, type PreparedRepositoryData, type PreparedResourceWrite } from './repositoryData';
import {
  markerMatches,
  parseRepositoryBootstrapMarker,
  repositoryBootstrapMarkerValue,
  repositoryBootstrapMetaKey,
  repositoryReadiness,
} from './status';

function comparableProtoJson(value: string): string {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  delete parsed.etag;
  return stableJson(parsed);
}

function matchesResource(
  actual: CatalogResourceRecord | CurrentResourceRecord,
  expected: PreparedResourceWrite,
): boolean {
  return actual.protoSchema === expected.protoSchema && comparableProtoJson(actual.protoJson) === comparableProtoJson(expected.protoJson);
}

function matchesRevision(actual: RevisionRecord, expected: PreparedRepositoryData['revisions'][number]): boolean {
  return actual.name === expected.name && actual.ownerName === expected.ownerName &&
    actual.protoSchema === expected.protoSchema && actual.revisionProtoJson === expected.revisionProtoJson &&
    actual.versionSequence === expected.versionSequence && actual.revisionOrigin === expected.revisionOrigin &&
    actual.lifecycle === expected.lifecycle && actual.exportEligible === expected.exportEligible &&
    actual.frozenDependenciesProtoJson === expected.frozenDependenciesProtoJson;
}

function matchesBundle(actual: ExportBundleRecord, expected: PreparedRepositoryData['bundles'][number]): boolean {
  return actual.rootRevisionName === expected.rootRevisionName && actual.rootKind === expected.rootKind &&
    actual.schemaVersion === expected.schemaVersion && actual.rendererVersion === expected.rendererVersion &&
    actual.contentSizeBytes === expected.contentSizeBytes && actual.contentSha256 === expected.contentSha256 &&
    actual.protoSchema === expected.protoSchema && actual.bundleProtoJson === expected.bundleProtoJson;
}

function currentPlaceholder(
  expected: PreparedRepositoryData['currents'][number],
  data: PreparedRepositoryData,
): CurrentResourceWriteInput {
  if (expected.protoSchema === RobotModelSchema.typeName) {
    const value = fromDomainJsonString(RobotModelSchema, expected.protoJson);
    return { protoSchema: expected.protoSchema, protoJson: JSON.stringify(toDomainJson(RobotModelSchema, create(RobotModelSchema, {
      ...value, currentRevision: '', etag: '',
    }))) };
  }
  const lastRevision = data.revisions
    .filter((revision) => revision.ownerName === expected.name)
    .sort((left, right) => left.versionSequence - right.versionSequence)
    .at(-1);
  const nextSequence = (lastRevision?.versionSequence ?? 0) + 1;
  if (expected.protoSchema === TaskSopSchema.typeName) {
    const value = fromDomainJsonString(TaskSopSchema, expected.protoJson);
    const draft = create(TaskSopSchema, {
      ...value,
      lifecycle: Lifecycle.DRAFT,
      currentRevision: '',
      candidateVersionSequence: value.candidateVersionSequence ?? BigInt(nextSequence),
      candidateVersionLabel: value.candidateVersionLabel ?? nextCandidateVersionAfter(lastRevision?.versionLabel),
      candidateSourceVersionId: value.candidateSourceVersionId,
      reviewedDependencyDigest: undefined,
      etag: '',
    });
    return {
      protoSchema: expected.protoSchema,
      protoJson: JSON.stringify(toDomainJson(TaskSopSchema, draft)),
      candidateVersionSequence: Number(draft.candidateVersionSequence),
      candidateVersionLabel: draft.candidateVersionLabel,
    };
  }
  if (expected.protoSchema === RequirementSchema.typeName) {
    const value = fromDomainJsonString(RequirementSchema, expected.protoJson);
    const draft = create(RequirementSchema, {
      ...value,
      lifecycle: Lifecycle.DRAFT,
      currentRevision: '',
      candidateVersionSequence: value.candidateVersionSequence ?? BigInt(nextSequence),
      candidateVersionLabel: value.candidateVersionLabel ?? nextCandidateVersionAfter(lastRevision?.versionLabel),
      candidateSourceVersionId: value.candidateSourceVersionId,
      reviewedDependencyDigest: undefined,
      etag: '',
    });
    return {
      protoSchema: expected.protoSchema,
      protoJson: JSON.stringify(toDomainJson(RequirementSchema, draft)),
      candidateVersionSequence: Number(draft.candidateVersionSequence),
      candidateVersionLabel: draft.candidateVersionLabel,
    };
  }
  throw new TypeError(`Unsupported current bootstrap schema: ${expected.protoSchema}`);
}

async function ensureCatalog(repository: ResourceRepository, expected: PreparedRepositoryData['catalogs'][number]): Promise<void> {
  const existing = await repository.getCatalog(expected.name);
  if (existing) {
    if (!matchesResource(existing, expected)) throw new TypeError(`Bootstrap catalog conflict: ${expected.name}`);
    return;
  }
  try { await repository.createCatalog(expected); } catch (error) {
    const raced = await repository.getCatalog(expected.name);
    if (!raced || !matchesResource(raced, expected)) throw error;
  }
}

async function ensureCurrentPlaceholder(
  repository: ResourceRepository,
  expected: PreparedRepositoryData['currents'][number],
  data: PreparedRepositoryData,
): Promise<void> {
  const placeholder = currentPlaceholder(expected, data);
  const existing = await repository.getCurrent(expected.name);
  if (existing) {
    if (!matchesResource(existing, expected) && !matchesResource(existing, { ...placeholder, name: expected.name })) {
      throw new TypeError(`Bootstrap current conflict: ${expected.name}`);
    }
    return;
  }
  try { await repository.createCurrent(placeholder); } catch (error) {
    const raced = await repository.getCurrent(expected.name);
    if (!raced || (!matchesResource(raced, expected) && !matchesResource(raced, { ...placeholder, name: expected.name }))) throw error;
  }
}

async function ensureRevision(repository: ResourceRepository, expected: PreparedRepositoryData['revisions'][number]): Promise<void> {
  const existing = await repository.getRevision(expected.name);
  if (existing) {
    if (!matchesRevision(existing, expected)) throw new TypeError(`Bootstrap revision conflict: ${expected.name}`);
    return;
  }
  try { await repository.createRevision(expected); } catch (error) {
    const raced = await repository.getRevision(expected.name);
    if (!raced || !matchesRevision(raced, expected)) throw error;
  }
}

async function ensureBundle(repository: ResourceRepository, expected: PreparedRepositoryData['bundles'][number]): Promise<void> {
  const existing = await repository.getExportBundle(expected.rootRevisionName);
  if (existing) {
    if (!matchesBundle(existing, expected)) throw new TypeError(`Bootstrap bundle conflict: ${expected.rootRevisionName}`);
    return;
  }
  try { await repository.createExportBundle(expected); } catch (error) {
    const raced = await repository.getExportBundle(expected.rootRevisionName);
    if (!raced || !matchesBundle(raced, expected)) throw error;
  }
}

async function finalizeCurrent(
  repository: ResourceRepository,
  expected: PreparedRepositoryData['currents'][number],
): Promise<void> {
  const existing = await repository.getCurrent(expected.name);
  if (!existing) throw new TypeError(`Bootstrap current disappeared: ${expected.name}`);
  if (matchesResource(existing, expected)) return;
  try { await repository.updateCurrent(expected.name, existing.etag, expected); } catch (error) {
    const raced = await repository.getCurrent(expected.name);
    if (!raced || !matchesResource(raced, expected)) throw error;
  }
}

async function verifyPreparedData(repository: ResourceRepository, data: PreparedRepositoryData): Promise<void> {
  for (const item of data.catalogs) {
    const actual = await repository.getCatalog(item.name);
    if (!actual || !matchesResource(actual, item)) throw new TypeError(`Bootstrap verification failed: ${item.name}`);
  }
  for (const item of data.currents) {
    const actual = await repository.getCurrent(item.name);
    if (!actual || !matchesResource(actual, item)) throw new TypeError(`Bootstrap verification failed: ${item.name}`);
  }
  for (const item of data.revisions) {
    const actual = await repository.getRevision(item.name);
    if (!actual || !matchesRevision(actual, item)) throw new TypeError(`Bootstrap verification failed: ${item.name}`);
  }
  for (const item of data.bundles) {
    const actual = await repository.getExportBundle(item.rootRevisionName);
    if (!actual || !matchesBundle(actual, item)) throw new TypeError(`Bootstrap verification failed: ${item.rootRevisionName}`);
  }
  await repository.auditProjectionParity();
}

export async function bootstrapRepository(
  repository: ResourceRepository,
  data: PreparedRepositoryData,
): Promise<{ state: 'COMPLETE'; idempotent: boolean; recovered: boolean }> {
  const inProgress = repositoryBootstrapMarkerValue('IN_PROGRESS', data);
  const complete = repositoryBootstrapMarkerValue('COMPLETE', data);
  const before = await repository.getMeta(repositoryBootstrapMetaKey);
  let recovered = false;
  if (!before) {
    const claimed = await repository.compareAndSetMeta({
      key: repositoryBootstrapMetaKey,
      nextValue: inProgress,
    });
    if (!claimed) return bootstrapRepository(repository, data);
  } else {
    const marker = parseRepositoryBootstrapMarker(before.value);
    if (!markerMatches(marker, data)) throw new TypeError('Repository bootstrap is owned by a different version or dataset digest');
    if (marker.state === 'COMPLETE') {
      await verifyPreparedData(repository, data);
      return { state: 'COMPLETE', idempotent: true, recovered: false };
    }
    if (before.value !== inProgress) throw new TypeError('Repository bootstrap marker is not canonical');
    recovered = true;
  }

  for (const item of data.catalogs) await ensureCatalog(repository, item);
  for (const item of data.currents) await ensureCurrentPlaceholder(repository, item, data);
  for (const item of [...data.revisions].sort((left, right) =>
    left.ownerName.localeCompare(right.ownerName, 'en') || left.versionSequence - right.versionSequence)) {
    await ensureRevision(repository, item);
  }
  for (const item of data.bundles) await ensureBundle(repository, item);
  for (const item of data.currents) await finalizeCurrent(repository, item);
  await verifyPreparedData(repository, data);

  const finalized = await repository.compareAndSetMeta({
    key: repositoryBootstrapMetaKey,
    expectedValue: inProgress,
    nextValue: complete,
  });
  if (!finalized) {
    const marker = await repository.getMeta(repositoryBootstrapMetaKey);
    if (!marker || marker.value !== complete) throw new TypeError('Repository bootstrap completion CAS failed');
  }
  const readiness = await repositoryReadiness(repository, data);
  if (!readiness.ready) throw new TypeError(`Repository bootstrap readiness failed: ${readiness.reason}`);
  return { state: 'COMPLETE', idempotent: false, recovered };
}
