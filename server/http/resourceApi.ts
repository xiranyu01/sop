import type { DescMessage, JsonValue } from '@bufbuild/protobuf';
import { timestampFromDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  AttachmentSchema,
  CustomerSchema,
  GlobalFieldSchema,
  MaterialSchema,
  MaterialStateRuleSchema,
  RobotModelSchema,
  SceneSchema,
} from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { Lifecycle } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { RequirementSchema } from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import { TaskSopSchema } from '../../gen/coscene/sop/v1alpha1/task_sop_pb';
import { apiError, type ApiErrorBody } from '../../shared/transport/errors';
import type {
  ResourceDetail,
  ResourceKind,
  ResourceMutationResult,
  ResourcePage,
  RevisionDetail,
  RevisionSummary as TransportRevisionSummary,
  SaveWarning,
  DependencyReviewResult,
  ConfirmationResult,
} from '../../shared/transport/resourceDto';
import { fromDomainJson, fromDomainJsonString, ProtoJsonDecodeError, toDomainJson } from '../../shared/domain/codec';
import { assertValidDomainMessage, DomainValidationError } from '../../shared/domain/validation';
import {
  InvalidCursorError,
  ProjectionMismatchError,
  RepositoryNotReadyError,
  ResourceConflictError,
  ResourceNotFoundError,
  type CatalogResourceKind,
  type CatalogResourceRecord,
  type CurrentResourceKind,
  type CurrentResourceRecord,
  type ResourceRepository,
  type ResourceSummary,
  type RevisionRecord,
  type RevisionSummary,
} from '../domain/repository';
import { RowSizeLimitError } from '../domain/rowSize';
import { resourceName } from '../domain/identity';
import { CanonicalDataError } from '../domain/errors';
import {
  acknowledgeRootDependencies,
  confirmRoot,
  DependencyReviewRequiredError,
  reviewRootDependencies,
} from '../domain/services/confirmation';
import { createRobotModel, saveRobotModel } from '../domain/services/robotModel';
import { discardDraft, startNextDraft } from '../domain/services/draftLifecycle';
import type { DependencyDiff } from '../domain/services/dependencyReview';
import {
  ATTACHMENT_PART_BYTES,
  attachmentResourceName,
  type AttachmentOwner,
  type createAttachmentService,
} from '../domain/services/attachment';
import { decodeExportBundle } from '../export/codec';
import { serializeExportBundleYaml } from '../export/yaml';
import { renderFrozenPdfModel } from '../../src/export/pdf';
import { repositoryReleaseManifest } from '../bootstrap/releaseManifest';
import {
  parseRepositoryBootstrapMarker,
  repositoryBootstrapMarkerValue,
  repositoryBootstrapMetaKey,
} from '../bootstrap/status';

type ResourceDefinition = {
  schema: DescMessage;
  persistence: 'catalog' | 'current';
  repositoryKind: CatalogResourceKind | CurrentResourceKind;
};

const resourceDefinitions: Record<ResourceKind, ResourceDefinition> = {
  customers: { schema: CustomerSchema, persistence: 'catalog', repositoryKind: 'CUSTOMER' },
  materials: { schema: MaterialSchema, persistence: 'catalog', repositoryKind: 'MATERIAL' },
  robotModels: { schema: RobotModelSchema, persistence: 'current', repositoryKind: 'ROBOT_MODEL' },
  scenes: { schema: SceneSchema, persistence: 'catalog', repositoryKind: 'SCENE' },
  globalFields: { schema: GlobalFieldSchema, persistence: 'catalog', repositoryKind: 'GLOBAL_FIELD' },
  materialStateRules: { schema: MaterialStateRuleSchema, persistence: 'catalog', repositoryKind: 'MATERIAL_STATE_RULE' },
  attachments: { schema: AttachmentSchema, persistence: 'catalog', repositoryKind: 'ATTACHMENT' },
  taskSops: { schema: TaskSopSchema, persistence: 'current', repositoryKind: 'TASK_SOP' },
  requirements: { schema: RequirementSchema, persistence: 'current', repositoryKind: 'REQUIREMENT' },
};

export type ResourceApiOptions = {
  /** Exact COMPLETE marker produced by the operator bootstrap for this release. */
  expectedBootstrapMarker?: string;
  requestId?: string;
  readRowSizeWarning?: () => SaveWarning | undefined;
  attachmentService?: ReturnType<typeof createAttachmentService>;
  createAttachmentService?: () => ReturnType<typeof createAttachmentService>;
};

type JsonObject = Record<string, unknown>;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

function errorResponse(status: number, body: ApiErrorBody): Response {
  return json(body, status);
}

function definition(value: string): { kind: ResourceKind; value: ResourceDefinition } | undefined {
  if (!Object.prototype.hasOwnProperty.call(resourceDefinitions, value)) return undefined;
  const kind = value as ResourceKind;
  return { kind, value: resourceDefinitions[kind] };
}

function decodeSegment(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) throw new TypeError(`${label} must not be empty`);
    return decoded;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${label} is not valid URI encoding`, { cause: error });
  }
}

function parseObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be a JSON object`);
  return value as JsonObject;
}

async function requestObject(request: Request): Promise<JsonObject> {
  return parseObject(await request.json(), 'request body');
}

async function boundedRequestArrayBuffer(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - totalBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is authoritative even if cancelling the source fails.
        }
        throw new TypeError('attachment part must not exceed 10 MiB');
      }
      if (value.byteLength > 0) {
        chunks.push(value);
        totalBytes += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requiredSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be an integer`);
  return value as number;
}

function parsePage(url: URL): { cursor?: string; limit?: number } {
  const cursor = url.searchParams.get('cursor') || undefined;
  const rawLimit = url.searchParams.get('pageSize') ?? url.searchParams.get('limit');
  if (rawLimit === null) return { cursor };
  if (!/^\d+$/.test(rawLimit)) throw new TypeError('pageSize must be a positive integer');
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('pageSize must be a positive integer');
  return { cursor, limit };
}

function parseProtoJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function resourceSummary(kind: ResourceKind, record: ResourceSummary): ResourceDetail {
  return {
    kind,
    name: record.name,
    uid: record.uid,
    sourceId: record.sourceId,
    displayName: record.displayName,
    etag: record.etag,
    lifecycle: record.lifecycle,
    currentRevision: 'currentRevisionName' in record && typeof record.currentRevisionName === 'string'
      ? record.currentRevisionName
      : undefined,
    sku: record.sku,
    fieldGroup: record.fieldGroup,
    fieldStatus: record.fieldStatus,
    sceneName: record.sceneName,
    customerName: record.customerName,
    robotModelRevisionName: record.robotModelRevisionName,
    archived: record.archivedAt !== undefined,
    resource: {},
  };
}

function resourceDetail(kind: ResourceKind, record: CatalogResourceRecord | CurrentResourceRecord): ResourceDetail {
  return { ...resourceSummary(kind, record), resource: parseProtoJson(record.protoJson) };
}

function resourcePage(kind: ResourceKind, page: { items: ResourceSummary[]; nextCursor?: string }): ResourcePage {
  return {
    items: page.items.map((item) => {
      const { resource: _resource, ...summary } = resourceSummary(kind, item);
      return summary;
    }),
    nextCursor: page.nextCursor,
  };
}

function sourceVersionId(protoJson: string): string | undefined {
  const value = parseProtoJson(protoJson);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value.sourceVersionId ?? value.source_version_id;
  return typeof raw === 'string' && raw ? raw : undefined;
}

function revisionSummary(record: RevisionSummary, sourceId?: string): TransportRevisionSummary {
  return {
    name: record.name,
    uid: record.uid,
    versionLabel: record.versionLabel,
    origin: record.revisionOrigin,
    lifecycle: record.lifecycle,
    exportEligible: record.exportEligible,
    sourceVersionId: sourceId,
  };
}

function revisionDetail(record: RevisionRecord): RevisionDetail {
  return {
    ...revisionSummary(record, sourceVersionId(record.revisionProtoJson)),
    ownerName: record.ownerName,
    kind: record.kind,
    previousRevisionName: record.previousRevisionName,
    resource: parseProtoJson(record.revisionProtoJson),
  };
}

function canonicalProtoJson(schema: DescMessage, value: unknown): string {
  const message = fromDomainJson(schema, value);
  assertValidDomainMessage(schema, message);
  return JSON.stringify(toDomainJson(schema, message));
}

function rawJsonField(value: JsonObject, camelCase: string, snakeCase = camelCase): unknown {
  return value[camelCase] ?? value[snakeCase];
}

function replaceRawJsonField(
  value: JsonObject,
  camelCase: string,
  snakeCase: string,
  authoritative: unknown,
): void {
  delete value[camelCase];
  if (snakeCase !== camelCase) delete value[snakeCase];
  if (authoritative !== undefined && authoritative !== null) value[camelCase] = authoritative;
}

/** Catalog PUT accepts business fields only. Raw JSON is sanitized before
 * Proto decoding so malformed client copies of ignored authority fields do
 * not turn an otherwise valid business update into a storage/projection error. */
function catalogUpdateProtoJson(
  schema: DescMessage,
  value: unknown,
  storedProtoJson: string,
  now = new Date(),
): string {
  const requested = { ...parseObject(value, 'resource') };
  const authoritative = parseObject(parseProtoJson(storedProtoJson), 'stored resource');
  for (const [camelCase, snakeCase] of [
    ['name', 'name'],
    ['uid', 'uid'],
    ['sourceId', 'source_id'],
    ['createTime', 'create_time'],
    ['etag', 'etag'],
  ] as const) {
    replaceRawJsonField(
      requested,
      camelCase,
      snakeCase,
      rawJsonField(authoritative, camelCase, snakeCase),
    );
  }
  replaceRawJsonField(requested, 'updateTime', 'update_time', now.toISOString());
  return canonicalProtoJson(schema, requested);
}

type VersionedDraftMessage = {
  name: string;
  uid: string;
  sourceId?: string;
  lifecycle: Lifecycle;
  currentRevision: string;
  candidateVersionSequence?: bigint;
  candidateVersionLabel?: string;
  candidateSourceVersionId?: string;
  reviewedDependencyDigest?: string;
  createTime?: Timestamp;
  updateTime?: Timestamp;
  etag: string;
};

/** Ordinary form saves may change business fields only. Lifecycle/version and
 * identity fields always come from the stored authoritative draft. */
function draftUpdateProtoJson(
  schema: DescMessage,
  value: unknown,
  storedProtoJson: string,
  now = new Date(),
): string {
  const requested = fromDomainJson(schema, value) as unknown as VersionedDraftMessage;
  const authoritative = fromDomainJsonString(schema, storedProtoJson) as unknown as VersionedDraftMessage;
  requested.name = authoritative.name;
  requested.uid = authoritative.uid;
  requested.sourceId = authoritative.sourceId;
  requested.lifecycle = authoritative.lifecycle;
  requested.currentRevision = authoritative.currentRevision;
  requested.candidateVersionSequence = authoritative.candidateVersionSequence;
  requested.candidateVersionLabel = authoritative.candidateVersionLabel;
  requested.candidateSourceVersionId = authoritative.candidateSourceVersionId;
  requested.reviewedDependencyDigest = authoritative.reviewedDependencyDigest;
  requested.createTime = authoritative.createTime;
  requested.updateTime = timestampFromDate(now);
  requested.etag = authoritative.etag;
  assertValidDomainMessage(schema, requested as never);
  return JSON.stringify(toDomainJson(schema, requested as never));
}

function clientSupplied(value: JsonObject, camelCase: string, snakeCase = camelCase): boolean {
  const names = camelCase === snakeCase ? [camelCase] : [camelCase, snakeCase];
  return names.some((name) => {
    const fieldValue = value[name];
    return fieldValue !== undefined && fieldValue !== null && fieldValue !== '';
  });
}

const createTimeResourceKinds = new Set<ResourceKind>([
  'customers',
  'materials',
  'robotModels',
  'scenes',
  'taskSops',
  'requirements',
]);

function createProtoJson(
  item: { kind: ResourceKind; value: ResourceDefinition },
  value: unknown,
  now = new Date(),
): string {
  const input = parseObject(value, 'resource');
  for (const [camelCase, snakeCase] of [
    ['name', 'name'],
    ['uid', 'uid'],
    ['etag', 'etag'],
    ['createTime', 'create_time'],
    ['updateTime', 'update_time'],
  ] as const) {
    if (clientSupplied(input, camelCase, snakeCase)) {
      throw new TypeError(`${camelCase} is allocated by the server`);
    }
  }
  if (item.value.persistence === 'current') {
    for (const [camel, snake] of [
      ['currentRevision', 'current_revision'],
      ['candidateVersionSequence', 'candidate_version_sequence'],
      ['candidateVersionLabel', 'candidate_version_label'],
      ['candidateSourceVersionId', 'candidate_source_version_id'],
      ['reviewedDependencyDigest', 'reviewed_dependency_digest'],
    ]) {
      if (clientSupplied(input, camel, snake)) throw new TypeError(`${camel} is allocated by the server`);
    }
  }

  const message = fromDomainJson(item.value.schema, input) as unknown as JsonObject;
  const seed = [input.sourceId, input.source_id, input.displayName, input.display_name, input.label,
    input.filename, input.materialType, input.material_type]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '') ?? crypto.randomUUID();
  message.name = resourceName(item.kind, seed);
  message.uid = crypto.randomUUID();
  message.etag = '';
  if (createTimeResourceKinds.has(item.kind)) message.createTime = timestampFromDate(now);
  message.updateTime = timestampFromDate(now);
  if (item.kind === 'taskSops' || item.kind === 'requirements') {
    const rawLifecycle = input.lifecycle;
    if (rawLifecycle !== undefined && rawLifecycle !== Lifecycle.DRAFT && rawLifecycle !== 'LIFECYCLE_DRAFT') {
      throw new TypeError('A new export root must start as a draft');
    }
    message.lifecycle = Lifecycle.DRAFT;
    message.currentRevision = '';
    message.candidateVersionSequence = 1n;
    message.candidateVersionLabel = '1.0.0';
    message.candidateSourceVersionId = undefined;
    message.reviewedDependencyDigest = undefined;
  }
  assertValidDomainMessage(item.value.schema, message as never);
  return JSON.stringify(toDomainJson(item.value.schema, message as never));
}

function isDraftProtoJson(protoJson: string): boolean {
  const value = parseProtoJson(protoJson);
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (value.lifecycle === 'LIFECYCLE_DRAFT' || value.lifecycle === Lifecycle.DRAFT));
}

function dependencyReviewResult(diff: DependencyDiff): DependencyReviewResult {
  return {
    proposalDigest: diff.digest,
    rootName: diff.proposal.rootName,
    rootEtag: diff.proposal.rootEtag,
    dependencies: diff.proposal.dependencies.map((item) => ({
      kind: item.kind,
      resourceName: item.resourceName,
      token: item.token,
    })),
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    empty: diff.empty,
  };
}

function archivedCurrentProtoJson(schema: DescMessage, protoJson: string): string {
  const message = fromDomainJsonString(schema, protoJson) as unknown as {
    lifecycle: Lifecycle;
    candidateVersionSequence?: bigint;
    candidateVersionLabel?: string;
    candidateSourceVersionId?: string;
  };
  message.lifecycle = Lifecycle.ARCHIVED;
  message.candidateVersionSequence = undefined;
  message.candidateVersionLabel = undefined;
  message.candidateSourceVersionId = undefined;
  assertValidDomainMessage(schema, message as never);
  return JSON.stringify(toDomainJson(schema, message as never));
}

async function requireReady(repository: ResourceRepository, expectedMarker?: string): Promise<void> {
  const expected = expectedMarker ?? repositoryBootstrapMarkerValue('COMPLETE', repositoryReleaseManifest);
  let marker;
  try {
    marker = parseRepositoryBootstrapMarker(expected);
  } catch {
    throw new RepositoryNotReadyError(repositoryBootstrapMetaKey, '<canonical release COMPLETE marker>', expected);
  }
  if (marker.state !== 'COMPLETE' || repositoryBootstrapMarkerValue('COMPLETE', marker) !== expected) {
    throw new RepositoryNotReadyError(repositoryBootstrapMetaKey, '<canonical release COMPLETE marker>', expected);
  }
  await repository.assertMeta(repositoryBootstrapMetaKey, expected);
}

async function loadResource(
  repository: ResourceRepository,
  item: { kind: ResourceKind; value: ResourceDefinition },
  name: string,
): Promise<CatalogResourceRecord | CurrentResourceRecord | undefined> {
  const record = item.value.persistence === 'catalog'
    ? await repository.getCatalog(name)
    : await repository.getCurrent(name);
  return record?.kind === item.value.repositoryKind ? record : undefined;
}

async function attachmentOwner(
  repository: ResourceRepository,
  item: { kind: ResourceKind; value: ResourceDefinition },
  name: string,
): Promise<AttachmentOwner> {
  const scope = item.kind === 'materials'
    ? 'material'
    : item.kind === 'taskSops'
      ? 'task_sop'
      : item.kind === 'requirements'
        ? 'requirement'
        : undefined;
  if (!scope) throw new TypeError('Attachments are supported only for Material, TaskSop, and Requirement owners');
  const owner = await loadResource(repository, item, name);
  if (!owner) throw new ResourceNotFoundError(name);
  return { scope, uid: owner.uid };
}

async function attachmentResponse(
  request: Request,
  repository: ResourceRepository,
  item: { kind: ResourceKind; value: ResourceDefinition },
  route: RegExpExecArray,
  options: ResourceApiOptions,
): Promise<Response> {
  const service = options.attachmentService ?? options.createAttachmentService?.();
  if (!service) throw new Error('Attachment storage is not configured');
  const ownerName = decodeSegment(route[2], 'attachment owner name');
  const owner = await attachmentOwner(repository, item, ownerName);
  const uid = route[3] ? decodeSegment(route[3], 'attachment uid') : undefined;
  const part = route[4];
  const action = route[5];
  const method = request.method.toUpperCase();

  if (!uid && !part && !action && method === 'POST') {
    const body = await requestObject(request);
    for (const field of ['owner', 'uid', 'key', 'objectKey', 'storageKey']) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        throw new TypeError(`${field} is allocated by the server`);
      }
    }
    const mediaType = body.mediaType ?? body.media_type;
    const sizeBytes = body.sizeBytes ?? body.size_bytes;
    const publicUrl = body.publicUrl ?? body.public_url;
    if (publicUrl !== undefined && typeof publicUrl !== 'string') throw new TypeError('publicUrl must be a string');
    const metadata = body.metadata === undefined ? undefined : parseObject(body.metadata, 'metadata');
    const initialized = await service.initialize({
      owner,
      filename: requiredString(body.filename, 'filename'),
      mediaType: requiredString(mediaType, 'mediaType'),
      sizeBytes: requiredSafeInteger(sizeBytes, 'sizeBytes'),
      ...(publicUrl === undefined ? {} : { publicUrl }),
      ...(metadata === undefined ? {} : { metadata }),
    });
    return json(initialized, 201);
  }
  if (!uid) return errorResponse(404, apiError('NOT_FOUND', '附件 API 路由不存在', undefined, options.requestId));

  if (part && !action && method === 'PUT') {
    if (!/^\d+$/.test(part)) throw new TypeError('part number must be a positive integer');
    const contentLength = request.headers.get('content-length');
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > ATTACHMENT_PART_BYTES)) {
      throw new TypeError('attachment part must not exceed 10 MiB');
    }
    return json(await service.uploadPart({
      owner,
      uid,
      partNumber: Number(part),
      body: await boundedRequestArrayBuffer(request, ATTACHMENT_PART_BYTES),
    }));
  }
  if (!part && action === 'complete' && method === 'POST') {
    const metadata = await service.complete({ owner, uid });
    return json({ ...metadata, name: attachmentResourceName(uid) });
  }
  if (!part && action === 'abort' && method === 'POST') {
    await service.abort({ owner, uid });
    return new Response(null, { status: 204 });
  }
  if (!part && !action && method === 'GET') {
    const metadata = await service.getMetadata({ owner, uid });
    if (!metadata) throw new ResourceNotFoundError(`attachments/${uid}`);
    return json(metadata);
  }
  if (!part && !action && method === 'DELETE') {
    if (!await service.unlink({ owner, uid })) throw new ResourceNotFoundError(`attachments/${uid}`);
    return new Response(null, { status: 204 });
  }
  return errorResponse(404, apiError('NOT_FOUND', '附件 API 路由不存在', undefined, options.requestId));
}

async function listResources(
  repository: ResourceRepository,
  item: { kind: ResourceKind; value: ResourceDefinition },
  url: URL,
): Promise<Response> {
  const page = parsePage(url);
  const result = item.value.persistence === 'catalog'
    ? await repository.listCatalog(item.value.repositoryKind as CatalogResourceKind, page)
    : await repository.listCurrent(item.value.repositoryKind as CurrentResourceKind, page);
  return json(resourcePage(item.kind, result));
}

async function createResource(
  request: Request,
  repository: ResourceRepository,
  item: { kind: ResourceKind; value: ResourceDefinition },
  options: ResourceApiOptions,
): Promise<Response> {
  if (item.kind === 'attachments') {
    throw new TypeError('Attachment metadata must be created through the bounded upload transition');
  }
  const body = await requestObject(request);
  const now = new Date();
  const protoJson = createProtoJson(item, body.resource, now);
  const writeTime = now.toISOString();
  const record = item.kind === 'robotModels'
    ? (await createRobotModel(repository, { resourceProtoJson: protoJson, now })).root
    : item.value.persistence === 'catalog'
      ? await repository.createCatalog({ protoSchema: item.value.schema.typeName, protoJson, now: writeTime })
      : await repository.createCurrent({ protoSchema: item.value.schema.typeName, protoJson, now: writeTime });
  const result: ResourceMutationResult = {
    resource: resourceDetail(item.kind, record),
    warning: options.readRowSizeWarning?.(),
  };
  return json(result, 201);
}

async function updateResource(
  request: Request,
  repository: ResourceRepository,
  item: { kind: ResourceKind; value: ResourceDefinition },
  name: string,
  options: ResourceApiOptions,
): Promise<Response> {
  if (item.kind === 'attachments') throw new TypeError('Attachment metadata is immutable');
  const body = await requestObject(request);
  const expectedEtag = requiredString(body.expectedEtag, 'expectedEtag');
  if (item.kind === 'robotModels') {
    const protoJson = JSON.stringify(parseObject(body.resource, 'resource'));
    const saved = await saveRobotModel(repository, {
      rootName: name,
      expectedEtag,
      resourceProtoJson: protoJson,
    });
    const result: ResourceMutationResult = {
      resource: resourceDetail(item.kind, saved.root),
      warning: options.readRowSizeWarning?.(),
    };
    return json(result);
  }
  const stored = await loadResource(repository, item, name);
  if (!stored) throw new ResourceNotFoundError(name);
  const catalogWriteTime = item.value.persistence === 'catalog' ? new Date() : undefined;
  const protoJson = item.value.persistence === 'current'
    ? draftUpdateProtoJson(item.value.schema, body.resource, stored.protoJson)
    : catalogUpdateProtoJson(item.value.schema, body.resource, stored.protoJson, catalogWriteTime);
  if (item.value.persistence === 'current') {
    if (stored.lifecycle !== 'DRAFT') throw new TypeError('Only an active draft can use the ordinary resource update route');
    if (!isDraftProtoJson(protoJson)) throw new TypeError('Ordinary resource updates cannot change draft lifecycle');
  }
  const record = item.value.persistence === 'catalog'
    ? await repository.updateCatalog(name, expectedEtag, {
      protoSchema: item.value.schema.typeName,
      protoJson,
      now: catalogWriteTime!.toISOString(),
    })
    : await repository.updateCurrent(name, expectedEtag, { protoSchema: item.value.schema.typeName, protoJson });
  const result: ResourceMutationResult = {
    resource: resourceDetail(item.kind, record),
    warning: options.readRowSizeWarning?.(),
  };
  return json(result);
}

async function archiveResource(
  request: Request,
  repository: ResourceRepository,
  item: { kind: ResourceKind; value: ResourceDefinition },
  name: string,
  options: ResourceApiOptions,
): Promise<Response> {
  if (item.kind === 'robotModels') throw new TypeError('RobotModel archive is not supported by the current Proto lifecycle');
  if (item.kind === 'attachments') throw new TypeError('Attachment metadata unlink uses the owner-scoped attachment route');
  const body = await requestObject(request);
  const expectedEtag = requiredString(body.expectedEtag, 'expectedEtag');
  const stored = await loadResource(repository, item, name);
  if (!stored) throw new ResourceNotFoundError(name);
  const protoJson = item.value.persistence === 'current'
    ? archivedCurrentProtoJson(item.value.schema, stored.protoJson)
    : stored.protoJson;
  const record = item.value.persistence === 'catalog'
    ? await repository.archiveCatalog(name, expectedEtag, { protoSchema: item.value.schema.typeName, protoJson })
    : await repository.archiveCurrent(name, expectedEtag, { protoSchema: item.value.schema.typeName, protoJson });
  const result: ResourceMutationResult = {
    resource: resourceDetail(item.kind, record),
    warning: options.readRowSizeWarning?.(),
  };
  return json(result);
}

function apiFailure(error: unknown, requestId?: string): Response {
  if (error instanceof DependencyReviewRequiredError) {
    return errorResponse(409, apiError('DEPENDENCY_CHANGED', '直接依赖已变化，需要重新确认审阅内容', {
      resourceName: error.diff.proposal.rootName,
      expectedEtag: error.diff.proposal.rootEtag,
      dependencyDiff: dependencyReviewResult(error.diff),
    }, requestId));
  }
  if (error instanceof ResourceConflictError) {
    return errorResponse(409, apiError('STALE_RESOURCE', '资源已被其他操作更新', {
      resourceName: error.resourceName,
      expectedEtag: error.expectedEtag,
      actualEtag: error.actualEtag,
    }, requestId));
  }
  if (error instanceof ResourceNotFoundError) {
    return errorResponse(404, apiError('NOT_FOUND', '资源不存在', { resourceName: error.resourceName }, requestId));
  }
  if (error instanceof RepositoryNotReadyError) {
    return errorResponse(503, apiError('NOT_INITIALIZED', '资源仓库尚未完成初始化', { retryable: true }, requestId));
  }
  if (error instanceof RowSizeLimitError) {
    return errorResponse(413, apiError('ROW_SIZE_REJECTED', '资源内容超过安全存储上限', {
      resourceKind: error.resourceKind,
      resourceName: error.resourceName,
      measuredBytes: error.bytes,
      limitBytes: error.limitBytes,
    }, requestId));
  }
  if (error instanceof DomainValidationError) {
    return errorResponse(400, apiError('VALIDATION', '资源校验失败', {
      violations: error.violations.map(({ fieldPath, message, ruleId }) => ({ fieldPath, message, ruleId })),
    }, requestId));
  }
  if (error instanceof CanonicalDataError) {
    return errorResponse(400, apiError('VALIDATION', error.message, undefined, requestId));
  }
  if (error instanceof Error && error.message.startsWith('Attachment boundary:')) {
    return errorResponse(400, apiError('VALIDATION', error.message, undefined, requestId));
  }
  if (error instanceof ProtoJsonDecodeError || error instanceof InvalidCursorError || error instanceof TypeError ||
      error instanceof RangeError || error instanceof SyntaxError) {
    return errorResponse(400, apiError('VALIDATION', error.message, undefined, requestId));
  }
  if (error instanceof ProjectionMismatchError) {
    return errorResponse(500, apiError('INTERNAL', '资源存储投影不一致', { resourceName: error.resourceName }, requestId));
  }
  return errorResponse(500, apiError('STORAGE_UNAVAILABLE', '资源存储暂时不可用', { retryable: true }, requestId));
}

/**
 * Resource-scoped REST adapter. Authentication belongs to the Pages boundary
 * and must run before this function, because this adapter can touch D1 and read
 * request bodies.
 */
export async function handleResourceApiRequest(
  request: Request,
  repository: ResourceRepository,
  options: ResourceApiOptions = {},
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname.replace(/\/$/, '') || '/';

    if ((method === 'GET' || method === 'HEAD') && pathname === '/api/health') {
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && pathname === '/api/readiness') {
      await requireReady(repository, options.expectedBootstrapMarker);
      await repository.auditProjectionParity();
      return json({ ready: true });
    }

    const revisionExport = /^\/api\/revisions\/([^/]+)\/export\.(yaml|pdf)$/.exec(pathname);
    const revisionDetailRoute = /^\/api\/revisions\/([^/]+)$/.exec(pathname);
    const attachmentRoute = /^\/api\/resources\/([^/]+)\/([^/]+)\/attachments(?:\/([^/]+)(?:\/parts\/([^/]+)|\/(complete|abort))?)?$/.exec(pathname);
    const resourceRoute = /^\/api\/resources\/([^/]+)(?:\/([^/]+))?(?:\/(archive|revisions|drafts|review-proposal|review-acknowledgements|confirmations))?$/.exec(pathname);
    if (!revisionExport && !revisionDetailRoute && !attachmentRoute && !resourceRoute) {
      return errorResponse(404, apiError('NOT_FOUND', 'API 路由不存在', undefined, options.requestId));
    }

    const resource = resourceRoute
      ? definition(resourceRoute[1])
      : attachmentRoute
        ? definition(attachmentRoute[1])
        : undefined;
    if ((resourceRoute || attachmentRoute) && !resource) {
      return errorResponse(404, apiError('NOT_FOUND', '资源类型不存在', undefined, options.requestId));
    }

    await requireReady(repository, options.expectedBootstrapMarker);

    if (revisionExport && method === 'GET') {
      const name = decodeSegment(revisionExport[1], 'revision name');
      const revision = await repository.getRevision(name);
      if (!revision) throw new ResourceNotFoundError(name);
      if (!revision.exportEligible || revision.lifecycle !== 'CONFIRMED') {
        return errorResponse(409, apiError('IMMUTABLE_REVISION', '该历史版本不可导出', { resourceName: name }, options.requestId));
      }
      const stored = await repository.getExportBundle(name);
      if (!stored) throw new ResourceNotFoundError(name);
      const bundle = decodeExportBundle(stored.bundleProtoJson);
      if (revisionExport[2] === 'pdf') {
        if (!bundle.content) throw new CanonicalDataError(`导出包缺少冻结内容：${name}`);
        return new Response(JSON.stringify(renderFrozenPdfModel(bundle.content)), {
          status: 200,
          headers: {
            'content-type': 'application/vnd.coscene.sop.pdf-model+json; charset=utf-8',
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${revision.versionLabel}.pdf-model.json`)}`,
          },
        });
      }
      const yaml = serializeExportBundleYaml(bundle);
      return new Response(yaml, {
        status: 200,
        headers: {
          'content-type': 'application/yaml; charset=utf-8',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${revision.versionLabel}.yaml`)}`,
        },
      });
    }

    if (revisionDetailRoute && method === 'GET') {
      const name = decodeSegment(revisionDetailRoute[1], 'revision name');
      const revision = await repository.getRevision(name);
      if (!revision) throw new ResourceNotFoundError(name);
      return json(revisionDetail(revision));
    }

    if (attachmentRoute && resource) {
      return await attachmentResponse(request, repository, resource, attachmentRoute, options);
    }

    if (!resource || !resourceRoute) {
      return errorResponse(404, apiError('NOT_FOUND', 'API 路由不存在', undefined, options.requestId));
    }

    const encodedName = resourceRoute[2];
    const action = resourceRoute[3];
    if (!encodedName && !action && method === 'GET') return await listResources(repository, resource, url);
    if (!encodedName && !action && method === 'POST') return await createResource(request, repository, resource, options);
    if (!encodedName) return errorResponse(404, apiError('NOT_FOUND', 'API 路由不存在', undefined, options.requestId));

    const name = decodeSegment(encodedName, 'resource name');
    if (!action && method === 'GET') {
      const record = await loadResource(repository, resource, name);
      if (!record) throw new ResourceNotFoundError(name);
      return json(resourceDetail(resource.kind, record));
    }
    if (!action && method === 'PUT') return await updateResource(request, repository, resource, name, options);
    if (action === 'archive' && method === 'POST') return await archiveResource(request, repository, resource, name, options);
    if (action === 'revisions' && method === 'GET') {
      if (resource.value.persistence !== 'current') {
        return errorResponse(404, apiError('NOT_FOUND', '该资源没有版本历史', { resourceName: name }, options.requestId));
      }
      const owner = await loadResource(repository, resource, name);
      if (!owner) throw new ResourceNotFoundError(name);
      const page = await repository.listRevisions(name, parsePage(url));
      return json({
        items: page.items.map((item) => revisionSummary(item)),
        nextCursor: page.nextCursor,
      });
    }
    if ((resource.kind === 'taskSops' || resource.kind === 'requirements') && action === 'drafts' && method === 'POST') {
      const body = await requestObject(request);
      const draft = await startNextDraft(repository, {
        rootName: name,
        expectedEtag: requiredString(body.expectedEtag, 'expectedEtag'),
      });
      const result: ResourceMutationResult = {
        resource: resourceDetail(resource.kind, draft),
        warning: options.readRowSizeWarning?.(),
      };
      return json(result);
    }
    if ((resource.kind === 'taskSops' || resource.kind === 'requirements') && action === 'drafts' && method === 'DELETE') {
      const body = await requestObject(request);
      const discarded = await discardDraft(repository, {
        rootName: name,
        expectedEtag: requiredString(body.expectedEtag, 'expectedEtag'),
      });
      const result: ResourceMutationResult = {
        resource: resourceDetail(resource.kind, discarded),
        warning: options.readRowSizeWarning?.(),
      };
      return json(result);
    }
    if ((resource.kind === 'taskSops' || resource.kind === 'requirements') && action === 'review-proposal' && method === 'POST') {
      const owner = await loadResource(repository, resource, name);
      if (!owner) throw new ResourceNotFoundError(name);
      return json(dependencyReviewResult(await reviewRootDependencies(repository, name)));
    }
    if ((resource.kind === 'taskSops' || resource.kind === 'requirements') && action === 'review-acknowledgements' && method === 'POST') {
      const body = await requestObject(request);
      const acknowledged = await acknowledgeRootDependencies(repository, {
        rootName: name,
        expectedEtag: requiredString(body.expectedEtag, 'expectedEtag'),
        proposalDigest: requiredString(body.proposalDigest, 'proposalDigest'),
      });
      const result: ResourceMutationResult = {
        resource: resourceDetail(resource.kind, acknowledged),
        warning: options.readRowSizeWarning?.(),
      };
      return json(result);
    }
    if ((resource.kind === 'taskSops' || resource.kind === 'requirements') && action === 'confirmations' && method === 'POST') {
      const body = await requestObject(request);
      const commandId = body.commandId === undefined ? undefined : requiredString(body.commandId, 'commandId');
      const confirmed = await confirmRoot(repository, {
        rootName: name,
        expectedEtag: requiredString(body.expectedEtag, 'expectedEtag'),
        commandId,
      });
      const result: ConfirmationResult = {
        resource: resourceDetail(resource.kind, confirmed.root),
        revision: revisionDetail(confirmed.revision),
        idempotent: confirmed.idempotent,
        exportPath: `/api/revisions/${encodeURIComponent(confirmed.revision.name)}/export.yaml`,
        warning: options.readRowSizeWarning?.(),
      };
      return json(result);
    }
    return errorResponse(404, apiError('NOT_FOUND', 'API 路由不存在', undefined, options.requestId));
  } catch (error) {
    return apiFailure(error, options.requestId);
  }
}
