import type {
  AtomicConfirmationInput,
  AtomicConfirmationResult,
  AtomicRobotModelCreateInput,
  AtomicRobotModelSaveInput,
  AtomicRobotModelSaveResult,
  CatalogResourceKind,
  CatalogResourceRecord,
  CurrentResourceKind,
  CurrentResourceRecord,
  CurrentArchiveState,
  CurrentResourceWriteInput,
  ExportBundleRecord,
  ExportBundleWriteInput,
  MetaCompareAndSetInput,
  MetaRecord,
  PageRequest,
  PageResult,
  ResourceRepository,
  ResourceSummary,
  ResourceWriteInput,
  ReviewedDependency,
  RevisionRecord,
  RevisionSummary,
  RevisionWriteInput,
} from '../domain/repository';
import {
  InvalidCursorError,
  MAX_BULK_RESOURCE_NAMES,
  ProjectionMismatchError,
  RepositoryNotReadyError,
  ResourceConflictError,
  ResourceNotFoundError,
} from '../domain/repository';
import { guardProspectiveRow, type RowSizeWarning, type VariableLengthValue } from '../domain/rowSize';
import { decodeExportBundle } from '../export/codec';
import {
  projectBundle,
  projectResource,
  projectRevision,
  projectionDifferences,
  withResourceEtag,
  withReviewedDependencyDigest,
} from './protoProjector';

export type D1RunResultLike = {
  success?: boolean;
  changes?: number;
  meta?: { changes?: number };
};

export type D1AllResultLike<T> = {
  results: T[];
  success?: boolean;
};

export type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1AllResultLike<T>>;
  run(): Promise<D1RunResultLike>;
};

export type D1DatabaseLike = {
  prepare(sql: string): D1PreparedStatementLike;
  batch<T extends D1RunResultLike = D1RunResultLike>(statements: D1PreparedStatementLike[]): Promise<T[]>;
};

export type D1ResourceRepositoryOptions = {
  clock?: () => string;
  createEtag?: () => string;
  onRowSizeWarning?: (warning: RowSizeWarning) => void;
};

type CatalogRow = {
  name: string;
  uid: string;
  kind: CatalogResourceKind;
  source_id: string | null;
  display_name: string;
  sku: string | null;
  field_group: string | null;
  field_status: string | null;
  etag: string;
  proto_schema: string;
  proto_json: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type CurrentRow = {
  name: string;
  uid: string;
  kind: CurrentResourceKind;
  source_id: string | null;
  display_name: string;
  scene_name: string | null;
  customer_name: string | null;
  robot_model_revision_name: string | null;
  project_display_name: string | null;
  deadline: string | null;
  production_item_count: number | null;
  aggregate_duration: string | null;
  lifecycle: CurrentResourceRecord['lifecycle'];
  candidate_version_sequence: number | null;
  candidate_version_label: string | null;
  candidate_source_version_id: string | null;
  current_revision_name: string | null;
  reviewed_manifest_digest: string | null;
  etag: string;
  proto_schema: string;
  proto_json: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type CurrentArchiveRow = {
  resource_name: string;
  resource_kind: 'TASK_SOP' | 'REQUIREMENT';
  archived_from_lifecycle: CurrentArchiveState['archivedFromLifecycle'];
  candidate_version_sequence: number | null;
  candidate_version_label: string | null;
  candidate_source_version_id: string | null;
  archived_at: string;
};

type ArchivedCurrentListRow = Pick<CurrentRow,
  'name' | 'uid' | 'kind' | 'source_id' | 'display_name' | 'scene_name' | 'customer_name'
  | 'robot_model_revision_name' | 'current_revision_name' | 'etag' | 'archived_at' | 'created_at'
  | 'project_display_name' | 'deadline' | 'production_item_count' | 'aggregate_duration'> & {
    current_version_label: string | null;
    archived_from_lifecycle: CurrentArchiveState['archivedFromLifecycle'];
    archive_candidate_version_sequence: number | null;
    archive_candidate_version_label: string | null;
    archive_candidate_source_version_id: string | null;
    archive_archived_at: string;
  };

type RevisionRow = {
  name: string;
  uid: string;
  owner_name: string;
  kind: RevisionRecord['kind'];
  version_sequence: number;
  version_label: string;
  previous_revision_name: string | null;
  revision_origin: RevisionRecord['revisionOrigin'];
  lifecycle: RevisionRecord['lifecycle'];
  export_eligible: number;
  confirmation_command_id: string | null;
  confirmed_from_etag: string | null;
  proto_schema: string;
  revision_proto_json: string;
  frozen_dependencies_proto_json: string | null;
  created_at: string;
};

type BundleRow = {
  root_revision_name: string;
  root_kind: ExportBundleRecord['rootKind'];
  schema_version: string;
  renderer_version: string;
  content_size_bytes: number;
  content_sha256: string;
  proto_schema: string;
  bundle_proto_json: string;
  created_at: string;
};

type ReviewedDependencyRow = {
  root_name: string;
  dependency_role: string;
  dependency_name: string;
  dependency_uid: string;
  token_kind: ReviewedDependency['tokenKind'];
  reviewed_token: string;
  created_at: string;
};

type MetaRow = { key: string; value: string; updated_at: string };

const CATALOG_DETAIL_COLUMNS = `name, uid, kind, source_id, display_name, sku, field_group, field_status, etag,
  proto_schema, proto_json, archived_at, created_at, updated_at`;
const CURRENT_DETAIL_COLUMNS = `name, uid, kind, source_id, display_name, scene_name, customer_name,
  robot_model_revision_name, project_display_name, deadline, production_item_count, aggregate_duration, lifecycle,
  candidate_version_sequence, candidate_version_label, candidate_source_version_id, current_revision_name,
  reviewed_manifest_digest, etag, proto_schema, proto_json, archived_at, created_at, updated_at`;
const REVISION_DETAIL_COLUMNS = `name, uid, owner_name, kind, version_sequence, version_label,
  previous_revision_name, revision_origin, lifecycle, export_eligible,
  confirmation_command_id, confirmed_from_etag, proto_schema, revision_proto_json,
  frozen_dependencies_proto_json, created_at`;
const BUNDLE_DETAIL_COLUMNS = `root_revision_name, root_kind, schema_version, renderer_version,
  content_size_bytes, content_sha256, proto_schema, bundle_proto_json, created_at`;

/** Keeps each D1 result comfortably below the Worker memory ceiling even when
 * every returned ProtoJSON row is close to the repository's 1.8 MB guard. */
export const PROJECTION_AUDIT_PAGE_SIZE = 16;

const CATALOG_KINDS = new Set<CatalogResourceKind>([
  'CUSTOMER',
  'MATERIAL',
  'SCENE',
  'GLOBAL_FIELD',
  'MATERIAL_STATE_RULE',
  'ATTACHMENT',
]);
const CURRENT_KINDS = new Set<CurrentResourceKind>(['ROBOT_MODEL', 'TASK_SOP', 'REQUIREMENT']);

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function changes(result: D1RunResultLike | undefined): number {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

type ResourceCursor = { createdAt: string; name: string };

function encodeCursor(createdAt: string, name: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 2, createdAt, name }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeCursor(cursor?: string): ResourceCursor {
  if (!cursor) return { createdAt: '', name: '' };
  try {
    const standard = cursor.replaceAll('-', '+').replaceAll('_', '/');
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as {
      version?: unknown;
      createdAt?: unknown;
      name?: unknown;
    };
    if (
      value.version !== 2
      || typeof value.createdAt !== 'string'
      || value.createdAt === ''
      || typeof value.name !== 'string'
      || value.name === ''
    ) throw new Error('invalid');
    return { createdAt: value.createdAt, name: value.name };
  } catch {
    throw new InvalidCursorError();
  }
}

type RevisionCursor = { sequence: number; name: string };

function encodeRevisionCursor(sequence: number, name: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, sequence, name }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeRevisionCursor(cursor?: string): RevisionCursor {
  if (!cursor) return { sequence: 0, name: '' };
  try {
    const standard = cursor.replaceAll('-', '+').replaceAll('_', '/');
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as {
      version?: unknown;
      sequence?: unknown;
      name?: unknown;
    };
    if (
      value.version !== 1
      || typeof value.sequence !== 'number'
      || !Number.isSafeInteger(value.sequence)
      || value.sequence < 1
      || typeof value.name !== 'string'
      || value.name === ''
    ) throw new Error('invalid');
    return { sequence: value.sequence, name: value.name };
  } catch {
    throw new InvalidCursorError();
  }
}

function pageLimit(request?: PageRequest): number {
  const requested = request?.limit ?? 100;
  if (!Number.isInteger(requested) || requested <= 0) throw new RangeError('Page limit must be a positive integer');
  return Math.min(requested, 200);
}

function toPage<T extends { name: string; createdAt?: string }>(rows: T[], limit: number): PageResult<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(rows.length > limit && last?.createdAt ? { nextCursor: encodeCursor(last.createdAt, last.name) } : {}),
  };
}

function toArchivedPage<T extends { name: string; archiveState?: CurrentArchiveState }>(rows: T[], limit: number): PageResult<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(rows.length > limit && last?.archiveState
      ? { nextCursor: encodeCursor(last.archiveState.archivedAt, last.name) }
      : {}),
  };
}

function toRevisionPage(rows: RevisionSummary[], limit: number): PageResult<RevisionSummary> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(rows.length > limit && last
      ? { nextCursor: encodeRevisionCursor(last.versionSequence, last.name) }
      : {}),
  };
}

function catalogRecord(row: CatalogRow): CatalogResourceRecord {
  return {
    name: row.name,
    uid: row.uid,
    kind: row.kind,
    sourceId: optional(row.source_id),
    displayName: row.display_name,
    sku: optional(row.sku),
    fieldGroup: optional(row.field_group),
    fieldStatus: optional(row.field_status),
    etag: row.etag,
    protoSchema: row.proto_schema,
    protoJson: row.proto_json,
    archivedAt: optional(row.archived_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function archiveState(row: CurrentArchiveRow): CurrentArchiveState {
  return {
    archivedAt: row.archived_at,
    archivedFromLifecycle: row.archived_from_lifecycle,
    candidateVersionSequence: optional(row.candidate_version_sequence),
    candidateVersionLabel: optional(row.candidate_version_label),
    candidateSourceVersionId: optional(row.candidate_source_version_id),
  };
}

function currentRecord(row: CurrentRow, archived?: CurrentArchiveState): CurrentResourceRecord {
  return {
    name: row.name,
    uid: row.uid,
    kind: row.kind,
    sourceId: optional(row.source_id),
    displayName: row.display_name,
    sceneName: optional(row.scene_name),
    customerName: optional(row.customer_name),
    robotModelRevisionName: optional(row.robot_model_revision_name),
    projectDisplayName: optional(row.project_display_name),
    deadline: optional(row.deadline),
    productionItemCount: optional(row.production_item_count),
    aggregateDuration: optional(row.aggregate_duration),
    lifecycle: row.lifecycle,
    candidateVersionSequence: optional(row.candidate_version_sequence),
    candidateVersionLabel: optional(row.candidate_version_label),
    candidateSourceVersionId: optional(row.candidate_source_version_id),
    currentRevisionName: optional(row.current_revision_name),
    reviewedManifestDigest: optional(row.reviewed_manifest_digest),
    etag: row.etag,
    protoSchema: row.proto_schema,
    protoJson: row.proto_json,
    archivedAt: optional(row.archived_at),
    archiveState: archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function revisionRecord(row: RevisionRow): RevisionRecord {
  return {
    name: row.name,
    uid: row.uid,
    ownerName: row.owner_name,
    kind: row.kind,
    versionSequence: row.version_sequence,
    versionLabel: row.version_label,
    previousRevisionName: optional(row.previous_revision_name),
    revisionOrigin: row.revision_origin,
    lifecycle: row.lifecycle,
    exportEligible: row.export_eligible === 1,
    confirmationCommandId: optional(row.confirmation_command_id),
    confirmedFromEtag: optional(row.confirmed_from_etag),
    protoSchema: row.proto_schema,
    revisionProtoJson: row.revision_proto_json,
    frozenDependenciesProtoJson: optional(row.frozen_dependencies_proto_json),
    createdAt: row.created_at,
  };
}

function revisionSummary(row: Omit<RevisionRow,
  'confirmation_command_id' | 'confirmed_from_etag' | 'proto_schema' | 'revision_proto_json' | 'frozen_dependencies_proto_json'>): RevisionSummary {
  return {
    name: row.name,
    uid: row.uid,
    ownerName: row.owner_name,
    kind: row.kind,
    versionSequence: row.version_sequence,
    versionLabel: row.version_label,
    previousRevisionName: optional(row.previous_revision_name),
    revisionOrigin: row.revision_origin,
    lifecycle: row.lifecycle,
    exportEligible: row.export_eligible === 1,
    createdAt: row.created_at,
  };
}

function bundleRecord(row: BundleRow): ExportBundleRecord {
  return {
    rootRevisionName: row.root_revision_name,
    rootKind: row.root_kind,
    schemaVersion: row.schema_version,
    rendererVersion: row.renderer_version,
    contentSizeBytes: row.content_size_bytes,
    contentSha256: row.content_sha256,
    protoSchema: row.proto_schema,
    bundleProtoJson: row.bundle_proto_json,
    createdAt: row.created_at,
  };
}

function reviewedDependency(row: ReviewedDependencyRow): ReviewedDependency {
  return {
    rootName: row.root_name,
    dependencyRole: row.dependency_role,
    dependencyName: row.dependency_name,
    dependencyUid: row.dependency_uid,
    tokenKind: row.token_kind,
    reviewedToken: row.reviewed_token,
    createdAt: row.created_at,
  };
}

function metaRecord(row: MetaRow): MetaRecord {
  return { key: row.key, value: row.value, updatedAt: row.updated_at };
}

function assertCatalogParity(row: CatalogRow): void {
  const projected = projectResource(row.proto_schema, row.proto_json);
  const differences = projectionDifferences(
    {
      name: row.name,
      uid: row.uid,
      kind: row.kind,
      sourceId: optional(row.source_id),
      displayName: row.display_name,
      sku: optional(row.sku),
      fieldGroup: optional(row.field_group),
      fieldStatus: optional(row.field_status),
      etag: row.etag,
    },
    projected,
  );
  if (differences.length > 0) throw new ProjectionMismatchError(row.name, differences);
}

function assertCurrentParity(row: CurrentRow): void {
  const projected = projectResource(row.proto_schema, row.proto_json);
  const differences = projectionDifferences(
    {
      name: row.name,
      uid: row.uid,
      kind: row.kind,
      sourceId: optional(row.source_id),
      displayName: row.display_name,
      sceneName: optional(row.scene_name),
      customerName: optional(row.customer_name),
      robotModelRevisionName: optional(row.robot_model_revision_name),
      projectDisplayName: optional(row.project_display_name),
      deadline: optional(row.deadline),
      productionItemCount: optional(row.production_item_count),
      aggregateDuration: optional(row.aggregate_duration),
      etag: row.etag,
      lifecycle: row.lifecycle,
      candidateVersionSequence: optional(row.candidate_version_sequence),
      candidateVersionLabel: optional(row.candidate_version_label),
      candidateSourceVersionId: optional(row.candidate_source_version_id),
      currentRevisionName: optional(row.current_revision_name),
      reviewedManifestDigest: optional(row.reviewed_manifest_digest),
    },
    projected,
  );
  if (differences.length > 0) throw new ProjectionMismatchError(row.name, differences);
}

function assertRevisionParity(row: RevisionRow): void {
  const projected = projectRevision(row.proto_schema, row.revision_proto_json, {
    revisionOrigin: row.revision_origin,
    lifecycle: row.lifecycle,
    exportEligible: row.export_eligible === 1,
  });
  const differences = projectionDifferences(
    {
      name: row.name,
      uid: row.uid,
      ownerName: row.owner_name,
      kind: row.kind,
      versionLabel: row.version_label,
      previousRevisionName: optional(row.previous_revision_name),
      revisionOrigin: row.revision_origin,
      lifecycle: row.lifecycle,
      exportEligible: row.export_eligible === 1,
    },
    projected,
  );
  if (differences.length > 0) throw new ProjectionMismatchError(row.name, differences);
}

function assertBundleParity(row: BundleRow): void {
  const projected = projectBundle(row.bundle_proto_json);
  const differences = projectionDifferences(
    {
      rootRevisionName: row.root_revision_name,
      rootKind: row.root_kind,
      schemaVersion: row.schema_version,
      rendererVersion: row.renderer_version,
      contentSizeBytes: row.content_size_bytes,
      contentSha256: row.content_sha256,
    },
    projected,
  );
  if (differences.length > 0) throw new ProjectionMismatchError(row.root_revision_name, differences);
}

function failIntegrity(key: string, expected: string, actual?: string): never {
  throw new RepositoryNotReadyError(`integrity.${key}`, expected, actual);
}

function catalogVariableColumns(record: CatalogResourceRecord): Record<string, VariableLengthValue> {
  return {
    name: record.name,
    uid: record.uid,
    kind: record.kind,
    sourceId: record.sourceId,
    displayName: record.displayName,
    sku: record.sku,
    fieldGroup: record.fieldGroup,
    fieldStatus: record.fieldStatus,
    etag: record.etag,
    protoSchema: record.protoSchema,
    protoJson: record.protoJson,
    archivedAt: record.archivedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function currentVariableColumns(record: CurrentResourceRecord): Record<string, VariableLengthValue> {
  return {
    name: record.name,
    uid: record.uid,
    kind: record.kind,
    sourceId: record.sourceId,
    displayName: record.displayName,
    sceneName: record.sceneName,
    customerName: record.customerName,
    robotModelRevisionName: record.robotModelRevisionName,
    projectDisplayName: record.projectDisplayName,
    deadline: record.deadline,
    aggregateDuration: record.aggregateDuration,
    etag: record.etag,
    protoSchema: record.protoSchema,
    protoJson: record.protoJson,
    archivedAt: record.archivedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lifecycle: record.lifecycle,
    candidateVersionLabel: record.candidateVersionLabel,
    candidateSourceVersionId: record.candidateSourceVersionId,
    currentRevisionName: record.currentRevisionName,
    reviewedManifestDigest: record.reviewedManifestDigest,
  };
}

function revisionVariableColumns(record: RevisionRecord): Record<string, VariableLengthValue> {
  return {
    name: record.name,
    uid: record.uid,
    ownerName: record.ownerName,
    kind: record.kind,
    versionLabel: record.versionLabel,
    previousRevisionName: record.previousRevisionName,
    revisionOrigin: record.revisionOrigin,
    lifecycle: record.lifecycle,
    confirmationCommandId: record.confirmationCommandId,
    confirmedFromEtag: record.confirmedFromEtag,
    protoSchema: record.protoSchema,
    revisionProtoJson: record.revisionProtoJson,
    frozenDependenciesProtoJson: record.frozenDependenciesProtoJson,
    createdAt: record.createdAt,
  };
}

function bundleVariableColumns(record: ExportBundleRecord): Record<string, VariableLengthValue> {
  return {
    rootRevisionName: record.rootRevisionName,
    rootKind: record.rootKind,
    schemaVersion: record.schemaVersion,
    rendererVersion: record.rendererVersion,
    contentSha256: record.contentSha256,
    protoSchema: record.protoSchema,
    bundleProtoJson: record.bundleProtoJson,
    createdAt: record.createdAt,
  };
}

function projectionError(resourceName: string, fields: string[]): never {
  throw new ProjectionMismatchError(resourceName, fields);
}

export function createD1ResourceRepository(
  db: D1DatabaseLike,
  options: D1ResourceRepositoryOptions = {},
): ResourceRepository {
  const now = options.clock ?? (() => new Date().toISOString());
  const createEtag = options.createEtag ?? (() => crypto.randomUUID());
  const warn = options.onRowSizeWarning;

  async function rawCatalog(name: string): Promise<CatalogRow | undefined> {
    return (await db.prepare(`SELECT ${CATALOG_DETAIL_COLUMNS}
      FROM SOP_CATALOG_RESOURCES WHERE name = ?`).bind(name).first<CatalogRow>()) ?? undefined;
  }

  async function rawCurrent(name: string): Promise<CurrentRow | undefined> {
    return (await db.prepare(`SELECT ${CURRENT_DETAIL_COLUMNS}
      FROM SOP_CURRENT_RESOURCES WHERE name = ?`).bind(name).first<CurrentRow>()) ?? undefined;
  }

  async function rawRevision(name: string): Promise<RevisionRow | undefined> {
    return (await db.prepare(`SELECT ${REVISION_DETAIL_COLUMNS}
      FROM SOP_REVISIONS WHERE name = ?`).bind(name).first<RevisionRow>()) ?? undefined;
  }

  async function rawBundle(rootRevisionName: string): Promise<BundleRow | undefined> {
    return (await db.prepare(`SELECT ${BUNDLE_DETAIL_COLUMNS}
      FROM SOP_EXPORT_BUNDLES WHERE root_revision_name = ?`).bind(rootRevisionName).first<BundleRow>()) ?? undefined;
  }

  function buildCatalog(input: ResourceWriteInput, createdAt: string, archivedAt?: string): CatalogResourceRecord {
    const updatedAt = input.now ?? now();
    const protoJson = withResourceEtag(input.protoJson, createEtag());
    const projected = projectResource(input.protoSchema, protoJson);
    if (!CATALOG_KINDS.has(projected.kind as CatalogResourceKind)) {
      throw new TypeError(`${projected.kind} is not a catalog resource`);
    }
    const record: CatalogResourceRecord = {
      name: projected.name,
      uid: projected.uid,
      kind: projected.kind as CatalogResourceKind,
      sourceId: projected.sourceId,
      displayName: projected.displayName,
      sku: projected.sku,
      fieldGroup: projected.fieldGroup,
      fieldStatus: projected.fieldStatus,
      etag: projected.etag,
      protoSchema: input.protoSchema,
      protoJson,
      archivedAt: input.archivedAt ?? archivedAt,
      createdAt,
      updatedAt,
    };
    guardProspectiveRow(record.kind, record.name, catalogVariableColumns(record), warn);
    return record;
  }

  function assertCurrentInputProjection(
    input: CurrentResourceWriteInput,
    projected: ReturnType<typeof projectResource>,
  ): void {
    const differences: string[] = [];
    if (input.candidateVersionSequence !== undefined && input.candidateVersionSequence !== projected.candidateVersionSequence) {
      differences.push('candidateVersionSequence');
    }
    if (input.candidateVersionLabel !== undefined && input.candidateVersionLabel !== projected.candidateVersionLabel) {
      differences.push('candidateVersionLabel');
    }
    if (input.candidateSourceVersionId !== undefined && input.candidateSourceVersionId !== projected.candidateSourceVersionId) {
      differences.push('candidateSourceVersionId');
    }
    if (input.reviewedManifestDigest !== undefined && input.reviewedManifestDigest !== projected.reviewedManifestDigest) {
      differences.push('reviewedManifestDigest');
    }
    if (differences.length > 0) projectionError(projected.name, differences);
  }

  function buildCurrent(
    input: CurrentResourceWriteInput,
    createdAt: string,
    archivedAt?: string,
    protoJsonOverride?: string,
  ): CurrentResourceRecord {
    const updatedAt = input.now ?? now();
    const protoJson = protoJsonOverride ?? withResourceEtag(input.protoJson, createEtag());
    const projected = projectResource(input.protoSchema, protoJson);
    if (!CURRENT_KINDS.has(projected.kind as CurrentResourceKind) || projected.lifecycle === undefined) {
      throw new TypeError(`${projected.kind} is not a current resource`);
    }
    assertCurrentInputProjection(input, projected);
    const record: CurrentResourceRecord = {
      name: projected.name,
      uid: projected.uid,
      kind: projected.kind as CurrentResourceKind,
      sourceId: projected.sourceId,
      displayName: projected.displayName,
      sceneName: projected.sceneName,
      customerName: projected.customerName,
      robotModelRevisionName: projected.robotModelRevisionName,
      projectDisplayName: projected.projectDisplayName,
      deadline: projected.deadline,
      productionItemCount: projected.productionItemCount,
      aggregateDuration: projected.aggregateDuration,
      lifecycle: projected.lifecycle,
      candidateVersionSequence: projected.candidateVersionSequence,
      candidateVersionLabel: projected.candidateVersionLabel,
      candidateSourceVersionId: projected.candidateSourceVersionId,
      currentRevisionName: projected.currentRevisionName,
      reviewedManifestDigest: projected.reviewedManifestDigest,
      etag: projected.etag,
      protoSchema: input.protoSchema,
      protoJson,
      archivedAt: input.archivedAt ?? archivedAt,
      createdAt,
      updatedAt,
    };
    guardProspectiveRow(record.kind, record.name, currentVariableColumns(record), warn);
    return record;
  }

  function buildRevision(input: RevisionWriteInput): RevisionRecord {
    const projected = projectRevision(input.protoSchema, input.revisionProtoJson, {
      revisionOrigin: input.revisionOrigin,
      lifecycle: input.lifecycle,
      exportEligible: input.exportEligible,
    });
    const differences: string[] = [];
    if (projected.kind === 'ROBOT_MODEL_REVISION') {
      if (input.exportEligible !== undefined && input.exportEligible !== projected.exportEligible) {
        differences.push('exportEligible');
      }
    } else {
      if (input.revisionOrigin !== undefined && input.revisionOrigin !== projected.revisionOrigin) {
        differences.push('revisionOrigin');
      }
      if (input.lifecycle !== undefined && input.lifecycle !== projected.lifecycle) differences.push('lifecycle');
      if (input.exportEligible !== undefined && input.exportEligible !== projected.exportEligible) {
        differences.push('exportEligible');
      }
    }
    if (differences.length > 0) projectionError(projected.name, differences);
    if (!Number.isSafeInteger(input.versionSequence) || input.versionSequence <= 0) {
      throw new RangeError('versionSequence must be a positive safe integer');
    }
    const record: RevisionRecord = {
      ...projected,
      versionSequence: input.versionSequence,
      confirmationCommandId: input.confirmationCommandId,
      confirmedFromEtag: input.confirmedFromEtag,
      protoSchema: input.protoSchema,
      revisionProtoJson: input.revisionProtoJson,
      frozenDependenciesProtoJson: input.frozenDependenciesProtoJson,
      createdAt: input.now ?? now(),
    };
    if ((record.confirmationCommandId === undefined) !== (record.confirmedFromEtag === undefined)) {
      throw new TypeError('Confirmation revision receipt must include both command id and source etag');
    }
    guardProspectiveRow(record.kind, record.name, revisionVariableColumns(record), warn);
    return record;
  }

  function buildBundle(input: ExportBundleWriteInput): ExportBundleRecord {
    const projected = projectBundle(input.bundleProtoJson);
    const expected = {
      rootRevisionName: input.rootRevisionName,
      rootKind: input.rootKind,
      schemaVersion: input.schemaVersion,
      rendererVersion: input.rendererVersion,
      contentSizeBytes: input.contentSizeBytes,
      contentSha256: input.contentSha256,
    };
    const differences = projectionDifferences(expected, projected);
    if (differences.length > 0) projectionError(input.rootRevisionName, differences);
    const record: ExportBundleRecord = {
      ...projected,
      protoSchema: input.protoSchema,
      bundleProtoJson: input.bundleProtoJson,
      createdAt: input.now ?? now(),
    };
    guardProspectiveRow('EXPORT_BUNDLE', record.rootRevisionName, bundleVariableColumns(record), warn);
    return record;
  }

  async function stale(resourceName: string, expectedEtag: string, table: 'SOP_CATALOG_RESOURCES' | 'SOP_CURRENT_RESOURCES'): Promise<never> {
    const row = await db.prepare(`SELECT etag FROM ${table} WHERE name = ?`).bind(resourceName).first<{ etag: string }>();
    if (!row) throw new ResourceNotFoundError(resourceName);
    throw new ResourceConflictError(resourceName, expectedEtag, row.etag);
  }

  async function getCatalog(name: string): Promise<CatalogResourceRecord | undefined> {
    const row = await rawCatalog(name);
    if (!row) return undefined;
    assertCatalogParity(row);
    return catalogRecord(row);
  }

  function bulkNames(names: readonly string[]): string[] {
    if (names.length > MAX_BULK_RESOURCE_NAMES) {
      throw new RangeError(`Bulk resource read limit exceeded: ${names.length} > ${MAX_BULK_RESOURCE_NAMES}`);
    }
    return [...new Set(names)].sort((left, right) => left.localeCompare(right, 'en'));
  }

  async function getCatalogs(names: readonly string[]): Promise<CatalogResourceRecord[]> {
    const normalized = bulkNames(names);
    if (normalized.length === 0) return [];
    const result = await db.prepare(`SELECT ${CATALOG_DETAIL_COLUMNS}
      FROM SOP_CATALOG_RESOURCES
      WHERE name IN (SELECT value FROM json_each(?))
      ORDER BY name ASC`).bind(JSON.stringify(normalized)).all<CatalogRow>();
    return result.results.map((row) => {
      assertCatalogParity(row);
      return catalogRecord(row);
    });
  }

  async function listCatalog(kind: CatalogResourceKind, page?: PageRequest): Promise<PageResult<ResourceSummary>> {
    const limit = pageLimit(page);
    const cursor = decodeCursor(page?.cursor);
    const result = await db.prepare(`SELECT name, uid, kind, source_id, display_name,
      sku, field_group, field_status, etag, archived_at, created_at
      FROM SOP_CATALOG_RESOURCES
      WHERE kind = ? AND archived_at IS NULL
        AND (? = '' OR created_at < ? OR (created_at = ? AND name > ?))
      ORDER BY created_at DESC, name ASC LIMIT ?`).bind(
        kind, cursor.createdAt, cursor.createdAt, cursor.createdAt, cursor.name, limit + 1,
      ).all<Pick<CatalogRow,
        'name' | 'uid' | 'kind' | 'source_id' | 'display_name' | 'sku' | 'field_group'
        | 'field_status' | 'etag' | 'archived_at' | 'created_at'>>();
    return toPage(result.results.map((row) => ({
      name: row.name,
      uid: row.uid,
      kind: row.kind,
      sourceId: optional(row.source_id),
      displayName: row.display_name,
      sku: optional(row.sku),
      fieldGroup: optional(row.field_group),
      fieldStatus: optional(row.field_status),
      etag: row.etag,
      archivedAt: optional(row.archived_at),
      createdAt: row.created_at,
    })), limit);
  }

  async function createCatalog(input: ResourceWriteInput): Promise<CatalogResourceRecord> {
    const createdAt = input.now ?? now();
    const record = buildCatalog(input, createdAt);
    await db.prepare(`INSERT INTO SOP_CATALOG_RESOURCES (
      name, uid, kind, source_id, display_name, sku, field_group, field_status,
      etag, proto_schema, proto_json,
      archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      record.name, record.uid, record.kind, record.sourceId ?? null, record.displayName,
      record.sku ?? null, record.fieldGroup ?? null, record.fieldStatus ?? null, record.etag,
      record.protoSchema, record.protoJson, record.archivedAt ?? null, record.createdAt, record.updatedAt,
    ).run();
    return record;
  }

  async function replaceGlobalFields(inputs: ResourceWriteInput[]): Promise<CatalogResourceRecord[]> {
    if (inputs.length === 0) throw new TypeError('GlobalField replacement must contain at least one resource');
    if (inputs.length > MAX_BULK_RESOURCE_NAMES) {
      throw new RangeError(`GlobalField replacement limit exceeded: ${inputs.length} > ${MAX_BULK_RESOURCE_NAMES}`);
    }
    const writeTime = now();
    const projectedNames = inputs.map((input) => {
      const parsed = JSON.parse(input.protoJson) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        typeof (parsed as { name?: unknown }).name !== 'string') {
        throw new TypeError('GlobalField replacement resource name is missing');
      }
      return (parsed as { name: string }).name;
    });
    if (new Set(projectedNames).size !== projectedNames.length) throw new TypeError('GlobalField replacement names must be unique');
    const existing = new Map((await getCatalogs(projectedNames)).map((record) => [record.name, record]));
    const records = inputs.map((input, index) => {
      const record = buildCatalog({ ...input, now: writeTime, archivedAt: undefined }, existing.get(projectedNames[index])?.createdAt ?? writeTime);
      if (record.kind !== 'GLOBAL_FIELD') throw new TypeError(`${record.name} is not a GlobalField`);
      return record;
    });
    const identities = records.flatMap((record) => [record.name, record.uid, record.sourceId ? `source:${record.sourceId}` : '']);
    const nonEmptyIdentities = identities.filter(Boolean);
    if (new Set(nonEmptyIdentities).size !== nonEmptyIdentities.length) {
      throw new TypeError('GlobalField replacement identities must be unique');
    }

    const payload = JSON.stringify(records.map((record) => ({
      name: record.name,
      uid: record.uid,
      kind: record.kind,
      sourceId: record.sourceId ?? null,
      displayName: record.displayName,
      sku: record.sku ?? null,
      fieldGroup: record.fieldGroup ?? null,
      fieldStatus: record.fieldStatus ?? null,
      etag: record.etag,
      protoSchema: record.protoSchema,
      protoJson: record.protoJson,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })));
    const results = await db.batch([
      db.prepare(`UPDATE SOP_CATALOG_RESOURCES
        SET archived_at = ?, updated_at = ?
        WHERE kind = 'GLOBAL_FIELD' AND archived_at IS NULL`).bind(writeTime, writeTime),
      db.prepare(`INSERT INTO SOP_CATALOG_RESOURCES (
        name, uid, kind, source_id, display_name, sku, field_group, field_status,
        etag, proto_schema, proto_json, archived_at, created_at, updated_at
      )
      SELECT
        json_extract(value, '$.name'),
        json_extract(value, '$.uid'),
        json_extract(value, '$.kind'),
        json_extract(value, '$.sourceId'),
        json_extract(value, '$.displayName'),
        json_extract(value, '$.sku'),
        json_extract(value, '$.fieldGroup'),
        json_extract(value, '$.fieldStatus'),
        json_extract(value, '$.etag'),
        json_extract(value, '$.protoSchema'),
        json_extract(value, '$.protoJson'),
        NULL,
        json_extract(value, '$.createdAt'),
        json_extract(value, '$.updatedAt')
      FROM json_each(?)
      WHERE 1
      ON CONFLICT(name) DO UPDATE SET
        source_id = excluded.source_id,
        display_name = excluded.display_name,
        sku = excluded.sku,
        field_group = excluded.field_group,
        field_status = excluded.field_status,
        etag = excluded.etag,
        proto_schema = excluded.proto_schema,
        proto_json = excluded.proto_json,
        archived_at = NULL,
        updated_at = excluded.updated_at`).bind(payload),
    ]);
    if (results.some((result) => result.success === false)) throw new Error('GlobalField replacement transaction failed');
    return records;
  }

  async function writeCatalog(
    name: string,
    expectedEtag: string,
    input: ResourceWriteInput,
    archive: boolean,
  ): Promise<CatalogResourceRecord> {
    const stored = await getCatalog(name);
    if (!stored) throw new ResourceNotFoundError(name);
    if (stored.etag !== expectedEtag) throw new ResourceConflictError(name, expectedEtag, stored.etag);
    const record = buildCatalog(
      { ...input, ...(archive ? { archivedAt: input.archivedAt ?? input.now ?? now() } : {}) },
      stored.createdAt,
      stored.archivedAt,
    );
    const identityDifferences = projectionDifferences(
      { name: stored.name, uid: stored.uid, kind: stored.kind },
      { name: record.name, uid: record.uid, kind: record.kind },
    );
    if (identityDifferences.length > 0) projectionError(name, identityDifferences);
    const result = await db.prepare(`UPDATE SOP_CATALOG_RESOURCES SET
      source_id = ?, display_name = ?, sku = ?, field_group = ?, field_status = ?,
      etag = ?, proto_schema = ?, proto_json = ?,
      archived_at = ?, updated_at = ?
      WHERE name = ? AND etag = ?`).bind(
      record.sourceId ?? null, record.displayName, record.sku ?? null, record.fieldGroup ?? null,
      record.fieldStatus ?? null, record.etag, record.protoSchema, record.protoJson,
      record.archivedAt ?? null, record.updatedAt, name, expectedEtag,
    ).run();
    if (changes(result) !== 1) return stale(name, expectedEtag, 'SOP_CATALOG_RESOURCES');
    return record;
  }

  async function getCurrentArchiveState(name: string): Promise<CurrentArchiveState | undefined> {
    const row = (await db.prepare(`SELECT resource_name, resource_kind, archived_from_lifecycle,
      candidate_version_sequence, candidate_version_label, candidate_source_version_id, archived_at
      FROM SOP_CURRENT_ARCHIVES WHERE resource_name = ?`).bind(name).first<CurrentArchiveRow>()) ?? undefined;
    return row ? archiveState(row) : undefined;
  }

  async function getCurrent(name: string): Promise<CurrentResourceRecord | undefined> {
    const row = await rawCurrent(name);
    if (!row) return undefined;
    assertCurrentParity(row);
    return currentRecord(row, row.archived_at ? await getCurrentArchiveState(name) : undefined);
  }

  async function getCurrentByUid(uid: string): Promise<CurrentResourceRecord | undefined> {
    const row = (await db.prepare(`SELECT ${CURRENT_DETAIL_COLUMNS}
      FROM SOP_CURRENT_RESOURCES WHERE uid = ?`).bind(uid).first<CurrentRow>()) ?? undefined;
    if (!row) return undefined;
    assertCurrentParity(row);
    return currentRecord(row, row.archived_at ? await getCurrentArchiveState(row.name) : undefined);
  }

  async function getCurrents(names: readonly string[]): Promise<CurrentResourceRecord[]> {
    const normalized = bulkNames(names);
    if (normalized.length === 0) return [];
    const result = await db.prepare(`SELECT ${CURRENT_DETAIL_COLUMNS}
      FROM SOP_CURRENT_RESOURCES
      WHERE name IN (SELECT value FROM json_each(?))
      ORDER BY name ASC`).bind(JSON.stringify(normalized)).all<CurrentRow>();
    return result.results.map((row) => {
      assertCurrentParity(row);
      return currentRecord(row);
    });
  }

  async function listCurrent(kind: CurrentResourceKind, page?: PageRequest): Promise<PageResult<ResourceSummary>> {
    const limit = pageLimit(page);
    const cursor = decodeCursor(page?.cursor);
    const result = await db.prepare(`SELECT current.name, current.uid, current.kind, current.source_id,
      current.display_name, current.scene_name, current.customer_name, current.robot_model_revision_name,
      current.lifecycle, current.current_revision_name, current.candidate_version_label,
      current.etag, current.archived_at, revision.version_label AS current_version_label,
      current.project_display_name, current.deadline, current.production_item_count, current.aggregate_duration,
      current.created_at
      FROM SOP_CURRENT_RESOURCES AS current
      LEFT JOIN SOP_REVISIONS AS revision ON revision.name = current.current_revision_name
      WHERE current.kind = ? AND current.archived_at IS NULL
        AND (? = '' OR current.created_at < ? OR (current.created_at = ? AND current.name > ?))
      ORDER BY current.created_at DESC, current.name ASC LIMIT ?`).bind(
        kind, cursor.createdAt, cursor.createdAt, cursor.createdAt, cursor.name, limit + 1,
      ).all<Pick<CurrentRow,
        'name' | 'uid' | 'kind' | 'source_id' | 'display_name' | 'scene_name' | 'customer_name'
        | 'robot_model_revision_name' | 'lifecycle' | 'current_revision_name' | 'candidate_version_label'
        | 'etag' | 'archived_at' | 'created_at'> & {
          current_version_label: string | null;
          project_display_name: string | null;
          deadline: string | null;
          production_item_count: number | null;
          aggregate_duration: string | null;
        }>();
    return toPage(result.results.map((row) => ({
      name: row.name,
      uid: row.uid,
      kind: row.kind,
      sourceId: optional(row.source_id),
      displayName: row.display_name,
      sceneName: optional(row.scene_name),
      customerName: optional(row.customer_name),
      robotModelRevisionName: optional(row.robot_model_revision_name),
      lifecycle: row.lifecycle,
      currentRevisionName: optional(row.current_revision_name),
      candidateVersionLabel: optional(row.candidate_version_label),
      currentVersionLabel: optional(row.current_version_label),
      projectDisplayName: optional(row.project_display_name),
      deadline: optional(row.deadline),
      productionItemCount: row.production_item_count ?? 0,
      aggregateDuration: optional(row.aggregate_duration),
      etag: row.etag,
      archivedAt: optional(row.archived_at),
      createdAt: row.created_at,
    })), limit);
  }

  async function listArchivedCurrent(
    kind: Exclude<CurrentResourceKind, 'ROBOT_MODEL'>,
    page?: PageRequest,
  ): Promise<PageResult<ResourceSummary>> {
    const limit = pageLimit(page);
    const cursor = decodeCursor(page?.cursor);
    const query = page?.query?.trim() ?? '';
    const pattern = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const result = await db.prepare(`SELECT current.name, current.uid, current.kind, current.source_id,
      current.display_name, current.scene_name, current.customer_name, current.robot_model_revision_name,
      current.current_revision_name, current.etag, current.archived_at, current.created_at,
      current.project_display_name, current.deadline, current.production_item_count, current.aggregate_duration,
      revision.version_label AS current_version_label,
      archive.archived_from_lifecycle,
      archive.candidate_version_sequence AS archive_candidate_version_sequence,
      archive.candidate_version_label AS archive_candidate_version_label,
      archive.candidate_source_version_id AS archive_candidate_source_version_id,
      archive.archived_at AS archive_archived_at
      FROM SOP_CURRENT_ARCHIVES AS archive
      JOIN SOP_CURRENT_RESOURCES AS current ON current.name = archive.resource_name
      LEFT JOIN SOP_REVISIONS AS revision ON revision.name = current.current_revision_name
      LEFT JOIN SOP_CATALOG_RESOURCES AS related
        ON related.name = COALESCE(current.customer_name, current.scene_name)
      WHERE archive.resource_kind = ? AND current.archived_at IS NOT NULL
        AND (? = '' OR current.display_name LIKE ? ESCAPE '\\'
          OR COALESCE(related.display_name, '') LIKE ? ESCAPE '\\'
          OR COALESCE(current.customer_name, current.scene_name, '') LIKE ? ESCAPE '\\'
          OR COALESCE(archive.candidate_version_label, revision.version_label, '') LIKE ? ESCAPE '\\')
        AND (? = '' OR archive.archived_at < ? OR (archive.archived_at = ? AND current.name > ?))
      ORDER BY archive.archived_at DESC, current.name ASC LIMIT ?`).bind(
        kind, query, pattern, pattern, pattern, pattern,
        cursor.createdAt, cursor.createdAt, cursor.createdAt, cursor.name, limit + 1,
      ).all<ArchivedCurrentListRow>();
    return toArchivedPage(result.results.map((row) => {
      const archived = archiveState({
        resource_name: row.name,
        resource_kind: kind,
        archived_from_lifecycle: row.archived_from_lifecycle,
        candidate_version_sequence: row.archive_candidate_version_sequence,
        candidate_version_label: row.archive_candidate_version_label,
        candidate_source_version_id: row.archive_candidate_source_version_id,
        archived_at: row.archive_archived_at,
      });
      return {
        name: row.name,
        uid: row.uid,
        kind: row.kind,
        sourceId: optional(row.source_id),
        displayName: row.display_name,
        sceneName: optional(row.scene_name),
        customerName: optional(row.customer_name),
        robotModelRevisionName: optional(row.robot_model_revision_name),
        lifecycle: 'ARCHIVED',
        currentRevisionName: optional(row.current_revision_name),
        candidateVersionLabel: archived.candidateVersionLabel,
        currentVersionLabel: optional(row.current_version_label),
        projectDisplayName: optional(row.project_display_name),
        deadline: optional(row.deadline),
        productionItemCount: row.production_item_count ?? 0,
        aggregateDuration: optional(row.aggregate_duration),
        etag: row.etag,
        archivedAt: optional(row.archived_at),
        archiveState: archived,
        createdAt: row.created_at,
      } satisfies ResourceSummary;
    }), limit);
  }

  async function createCurrent(input: CurrentResourceWriteInput): Promise<CurrentResourceRecord> {
    const createdAt = input.now ?? now();
    const record = buildCurrent(input, createdAt);
    await db.prepare(`INSERT INTO SOP_CURRENT_RESOURCES (
      name, uid, kind, source_id, display_name, scene_name, customer_name,
      robot_model_revision_name, project_display_name, deadline, production_item_count, aggregate_duration,
      lifecycle, candidate_version_sequence,
      candidate_version_label, candidate_source_version_id, current_revision_name,
      reviewed_manifest_digest, etag, proto_schema, proto_json, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      record.name, record.uid, record.kind, record.sourceId ?? null, record.displayName,
      record.sceneName ?? null, record.customerName ?? null, record.robotModelRevisionName ?? null,
      record.projectDisplayName ?? null, record.deadline ?? null, record.productionItemCount ?? null,
      record.aggregateDuration ?? null,
      record.lifecycle,
      record.candidateVersionSequence ?? null, record.candidateVersionLabel ?? null,
      record.candidateSourceVersionId ?? null, record.currentRevisionName ?? null,
      record.reviewedManifestDigest ?? null, record.etag, record.protoSchema, record.protoJson,
      record.archivedAt ?? null, record.createdAt, record.updatedAt,
    ).run();
    return record;
  }

  async function writeCurrent(
    name: string,
    expectedEtag: string,
    input: CurrentResourceWriteInput,
    archive: boolean,
  ): Promise<CurrentResourceRecord> {
    const stored = await getCurrent(name);
    if (!stored) throw new ResourceNotFoundError(name);
    if (stored.etag !== expectedEtag) throw new ResourceConflictError(name, expectedEtag, stored.etag);
    const record = buildCurrent(
      { ...input, ...(archive ? { archivedAt: input.archivedAt ?? input.now ?? now() } : {}) },
      stored.createdAt,
      stored.archivedAt,
    );
    const identityDifferences = projectionDifferences(
      { name: stored.name, uid: stored.uid, kind: stored.kind },
      { name: record.name, uid: record.uid, kind: record.kind },
    );
    if (identityDifferences.length > 0) projectionError(name, identityDifferences);
    if (archive && record.lifecycle !== 'ARCHIVED') projectionError(name, ['lifecycle']);
    const result = await db.prepare(`UPDATE SOP_CURRENT_RESOURCES SET
      source_id = ?, display_name = ?, scene_name = ?, customer_name = ?,
      robot_model_revision_name = ?, project_display_name = ?, deadline = ?, production_item_count = ?,
      aggregate_duration = ?, lifecycle = ?, candidate_version_sequence = ?,
      candidate_version_label = ?, candidate_source_version_id = ?, current_revision_name = ?,
      reviewed_manifest_digest = ?, etag = ?, proto_schema = ?, proto_json = ?, archived_at = ?, updated_at = ?
      WHERE name = ? AND etag = ?`).bind(
      record.sourceId ?? null, record.displayName, record.sceneName ?? null, record.customerName ?? null,
      record.robotModelRevisionName ?? null, record.projectDisplayName ?? null, record.deadline ?? null,
      record.productionItemCount ?? null, record.aggregateDuration ?? null,
      record.lifecycle, record.candidateVersionSequence ?? null,
      record.candidateVersionLabel ?? null, record.candidateSourceVersionId ?? null,
      record.currentRevisionName ?? null, record.reviewedManifestDigest ?? null, record.etag,
      record.protoSchema, record.protoJson, record.archivedAt ?? null, record.updatedAt, name, expectedEtag,
    ).run();
    if (changes(result) !== 1) return stale(name, expectedEtag, 'SOP_CURRENT_RESOURCES');
    return record;
  }

  async function archiveCurrentForLibrary(
    name: string,
    expectedEtag: string,
    input: CurrentResourceWriteInput,
  ): Promise<CurrentResourceRecord> {
    const stored = await getCurrent(name);
    if (!stored) throw new ResourceNotFoundError(name);
    if (stored.etag !== expectedEtag) throw new ResourceConflictError(name, expectedEtag, stored.etag);
    if (stored.archivedAt || stored.archiveState) throw new Error(`Resource is already archived: ${name}`);
    if (stored.kind === 'ROBOT_MODEL' || !['DRAFT', 'CONFIRMED'].includes(stored.lifecycle)) {
      throw new Error(`Resource cannot enter the archive library: ${name}`);
    }
    if (stored.lifecycle === 'DRAFT' && (!stored.candidateVersionSequence || !stored.candidateVersionLabel)) {
      throw new Error(`Draft archive metadata is incomplete: ${name}`);
    }
    const archivedAt = input.now ?? now();
    const record = buildCurrent({ ...input, archivedAt }, stored.createdAt, stored.archivedAt);
    if (record.lifecycle !== 'ARCHIVED') projectionError(name, ['lifecycle']);
    const identityDifferences = projectionDifferences(
      { name: stored.name, uid: stored.uid, kind: stored.kind },
      { name: record.name, uid: record.uid, kind: record.kind },
    );
    if (identityDifferences.length > 0) projectionError(name, identityDifferences);
    const results = await db.batch([
      db.prepare(`INSERT INTO SOP_CURRENT_ARCHIVES (
        resource_name, resource_kind, archived_from_lifecycle,
        candidate_version_sequence, candidate_version_label, candidate_source_version_id, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
        name, stored.kind, stored.lifecycle,
        stored.lifecycle === 'DRAFT' ? stored.candidateVersionSequence ?? null : null,
        stored.lifecycle === 'DRAFT' ? stored.candidateVersionLabel ?? null : null,
        stored.lifecycle === 'DRAFT' ? stored.candidateSourceVersionId ?? null : null,
        archivedAt,
      ),
      db.prepare(`UPDATE SOP_CURRENT_RESOURCES SET
        source_id = ?, display_name = ?, scene_name = ?, customer_name = ?,
        robot_model_revision_name = ?, project_display_name = ?, deadline = ?, production_item_count = ?,
        aggregate_duration = ?, lifecycle = ?, candidate_version_sequence = ?,
        candidate_version_label = ?, candidate_source_version_id = ?, current_revision_name = ?,
        reviewed_manifest_digest = ?, etag = ?, proto_schema = ?, proto_json = ?, archived_at = ?, updated_at = ?
        WHERE name = ? AND etag = ?`).bind(
        record.sourceId ?? null, record.displayName, record.sceneName ?? null, record.customerName ?? null,
        record.robotModelRevisionName ?? null, record.projectDisplayName ?? null, record.deadline ?? null,
        record.productionItemCount ?? null, record.aggregateDuration ?? null,
        record.lifecycle, record.candidateVersionSequence ?? null,
        record.candidateVersionLabel ?? null, record.candidateSourceVersionId ?? null,
        record.currentRevisionName ?? null, record.reviewedManifestDigest ?? null, record.etag,
        record.protoSchema, record.protoJson, record.archivedAt ?? null, record.updatedAt, name, expectedEtag,
      ),
    ]);
    if (results.some((result) => result.success === false) || changes(results[1]) !== 1) {
      return stale(name, expectedEtag, 'SOP_CURRENT_RESOURCES');
    }
    return { ...record, archiveState: {
      archivedAt,
      archivedFromLifecycle: stored.lifecycle as 'DRAFT' | 'CONFIRMED',
      candidateVersionSequence: stored.lifecycle === 'DRAFT' ? stored.candidateVersionSequence : undefined,
      candidateVersionLabel: stored.lifecycle === 'DRAFT' ? stored.candidateVersionLabel : undefined,
      candidateSourceVersionId: stored.lifecycle === 'DRAFT' ? stored.candidateSourceVersionId : undefined,
    } };
  }

  async function restoreCurrentFromLibrary(
    name: string,
    expectedEtag: string,
    input: CurrentResourceWriteInput,
  ): Promise<CurrentResourceRecord> {
    const stored = await getCurrent(name);
    if (!stored) throw new ResourceNotFoundError(name);
    if (stored.etag !== expectedEtag) throw new ResourceConflictError(name, expectedEtag, stored.etag);
    const archived = stored.archiveState;
    if (!stored.archivedAt || !archived) throw new Error(`Resource is not in the archive library: ${name}`);
    const record = buildCurrent({ ...input, archivedAt: undefined }, stored.createdAt, undefined);
    if (record.lifecycle !== archived.archivedFromLifecycle) projectionError(name, ['lifecycle']);
    if (record.lifecycle === 'DRAFT' && (
      record.candidateVersionSequence !== archived.candidateVersionSequence
      || record.candidateVersionLabel !== archived.candidateVersionLabel
      || record.candidateSourceVersionId !== archived.candidateSourceVersionId
    )) projectionError(name, ['candidateVersion']);
    const identityDifferences = projectionDifferences(
      { name: stored.name, uid: stored.uid, kind: stored.kind },
      { name: record.name, uid: record.uid, kind: record.kind },
    );
    if (identityDifferences.length > 0) projectionError(name, identityDifferences);
    const statements = [
      db.prepare(`UPDATE SOP_CURRENT_RESOURCES SET
        source_id = ?, display_name = ?, scene_name = ?, customer_name = ?,
        robot_model_revision_name = ?, project_display_name = ?, deadline = ?, production_item_count = ?,
        aggregate_duration = ?, lifecycle = ?, candidate_version_sequence = ?,
        candidate_version_label = ?, candidate_source_version_id = ?, current_revision_name = ?,
        reviewed_manifest_digest = ?, etag = ?, proto_schema = ?, proto_json = ?, archived_at = NULL, updated_at = ?
        WHERE name = ? AND etag = ?`).bind(
        record.sourceId ?? null, record.displayName, record.sceneName ?? null, record.customerName ?? null,
        record.robotModelRevisionName ?? null, record.projectDisplayName ?? null, record.deadline ?? null,
        record.productionItemCount ?? null, record.aggregateDuration ?? null,
        record.lifecycle, record.candidateVersionSequence ?? null,
        record.candidateVersionLabel ?? null, record.candidateSourceVersionId ?? null,
        record.currentRevisionName ?? null, record.reviewedManifestDigest ?? null, record.etag,
        record.protoSchema, record.protoJson, record.updatedAt, name, expectedEtag,
      ),
      ...(record.lifecycle === 'DRAFT'
        ? [db.prepare('DELETE FROM SOP_REVIEWED_DEPENDENCIES WHERE root_name = ?').bind(name)]
        : []),
      db.prepare('DELETE FROM SOP_CURRENT_ARCHIVES WHERE resource_name = ?').bind(name),
    ];
    const results = await db.batch(statements);
    if (results.some((result) => result.success === false) || changes(results[0]) !== 1) {
      return stale(name, expectedEtag, 'SOP_CURRENT_RESOURCES');
    }
    return { ...record, archivedAt: undefined, archiveState: undefined };
  }

  async function findActiveRequirementReferrers(taskOwnerName: string): Promise<ResourceSummary[]> {
    const result = await db.prepare(`SELECT DISTINCT requirement.name, requirement.uid, requirement.kind,
      requirement.source_id, requirement.display_name, requirement.customer_name,
      requirement.lifecycle, requirement.current_revision_name, requirement.candidate_version_label,
      requirement.etag, requirement.archived_at, requirement.created_at,
      requirement.project_display_name, requirement.deadline, requirement.production_item_count,
      requirement.aggregate_duration, current_revision.version_label AS current_version_label
      FROM SOP_CURRENT_RESOURCES AS requirement
      JOIN json_each(requirement.proto_json, '$.spec.productionItems') AS production
      JOIN SOP_REVISIONS AS task_revision
        ON task_revision.name = json_extract(production.value, '$.taskSopRevision')
      LEFT JOIN SOP_REVISIONS AS current_revision
        ON current_revision.name = requirement.current_revision_name
      WHERE requirement.kind = 'REQUIREMENT' AND requirement.archived_at IS NULL
        AND task_revision.owner_name = ?
      ORDER BY requirement.created_at DESC, requirement.name ASC LIMIT 50`).bind(taskOwnerName).all<{
        name: string; uid: string; kind: CurrentResourceKind; source_id: string | null; display_name: string;
        customer_name: string | null; lifecycle: CurrentResourceRecord['lifecycle']; current_revision_name: string | null;
        candidate_version_label: string | null; etag: string; archived_at: string | null; created_at: string;
        project_display_name: string | null; deadline: string | null; production_item_count: number | null;
        aggregate_duration: string | null; current_version_label: string | null;
      }>();
    return result.results.map((row) => ({
      name: row.name, uid: row.uid, kind: row.kind, sourceId: optional(row.source_id),
      displayName: row.display_name, customerName: optional(row.customer_name), lifecycle: row.lifecycle,
      currentRevisionName: optional(row.current_revision_name), candidateVersionLabel: optional(row.candidate_version_label),
      currentVersionLabel: optional(row.current_version_label), projectDisplayName: optional(row.project_display_name),
      deadline: optional(row.deadline), productionItemCount: row.production_item_count ?? 0,
      aggregateDuration: optional(row.aggregate_duration), etag: row.etag,
      archivedAt: optional(row.archived_at), createdAt: row.created_at,
    }));
  }

  async function getRevision(name: string): Promise<RevisionRecord | undefined> {
    const row = await rawRevision(name);
    if (!row) return undefined;
    assertRevisionParity(row);
    return revisionRecord(row);
  }

  async function getRevisionByUid(uid: string): Promise<RevisionRecord | undefined> {
    const row = (await db.prepare(`SELECT ${REVISION_DETAIL_COLUMNS}
      FROM SOP_REVISIONS WHERE uid = ?`).bind(uid).first<RevisionRow>()) ?? undefined;
    if (!row) return undefined;
    assertRevisionParity(row);
    return revisionRecord(row);
  }

  async function getRevisions(names: readonly string[]): Promise<RevisionRecord[]> {
    const normalized = bulkNames(names);
    if (normalized.length === 0) return [];
    const result = await db.prepare(`SELECT ${REVISION_DETAIL_COLUMNS}
      FROM SOP_REVISIONS
      WHERE name IN (SELECT value FROM json_each(?))
      ORDER BY name ASC`).bind(JSON.stringify(normalized)).all<RevisionRow>();
    return result.results.map((row) => {
      assertRevisionParity(row);
      return revisionRecord(row);
    });
  }

  async function listRevisions(ownerName: string, page?: PageRequest): Promise<PageResult<RevisionSummary>> {
    const limit = pageLimit(page);
    const cursor = decodeRevisionCursor(page?.cursor);
    const result = await db.prepare(`SELECT name, uid, owner_name, kind, version_sequence,
      version_label, previous_revision_name, revision_origin, lifecycle, export_eligible, created_at
      FROM SOP_REVISIONS WHERE owner_name = ?
        AND (version_sequence > ? OR (version_sequence = ? AND name > ?))
      ORDER BY version_sequence ASC, name ASC LIMIT ?`).bind(
        ownerName, cursor.sequence, cursor.sequence, cursor.name, limit + 1,
      ).all<Omit<RevisionRow,
        'confirmation_command_id' | 'confirmed_from_etag' | 'proto_schema'
        | 'revision_proto_json' | 'frozen_dependencies_proto_json'>>();
    return toRevisionPage(result.results.map(revisionSummary), limit);
  }

  async function createRevision(input: RevisionWriteInput): Promise<RevisionRecord> {
    const record = buildRevision(input);
    await db.prepare(`INSERT INTO SOP_REVISIONS (
      name, uid, owner_name, kind, version_sequence, version_label, previous_revision_name,
      revision_origin, lifecycle, export_eligible, confirmation_command_id, confirmed_from_etag,
      proto_schema, revision_proto_json, frozen_dependencies_proto_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      record.name, record.uid, record.ownerName, record.kind, record.versionSequence, record.versionLabel,
      record.previousRevisionName ?? null, record.revisionOrigin, record.lifecycle,
      record.exportEligible ? 1 : 0, record.confirmationCommandId ?? null, record.confirmedFromEtag ?? null,
      record.protoSchema, record.revisionProtoJson,
      record.frozenDependenciesProtoJson ?? null, record.createdAt,
    ).run();
    return record;
  }

  async function getExportBundle(rootRevisionName: string): Promise<ExportBundleRecord | undefined> {
    const row = await rawBundle(rootRevisionName);
    if (!row) return undefined;
    assertBundleParity(row);
    return bundleRecord(row);
  }

  async function createExportBundle(input: ExportBundleWriteInput): Promise<ExportBundleRecord> {
    const record = buildBundle(input);
    await db.prepare(`INSERT INTO SOP_EXPORT_BUNDLES (
      root_revision_name, root_kind, schema_version, renderer_version, content_size_bytes,
      content_sha256, proto_schema, bundle_proto_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      record.rootRevisionName, record.rootKind, record.schemaVersion, record.rendererVersion,
      record.contentSizeBytes, record.contentSha256, record.protoSchema, record.bundleProtoJson, record.createdAt,
    ).run();
    return record;
  }

  async function loadReviewedDependencies(rootName: string): Promise<ReviewedDependency[]> {
    const result = await db.prepare(`SELECT root_name, dependency_role, dependency_name, dependency_uid,
      token_kind, reviewed_token, created_at
      FROM SOP_REVIEWED_DEPENDENCIES WHERE root_name = ?
      ORDER BY dependency_role ASC, dependency_name ASC`).bind(rootName).all<ReviewedDependencyRow>();
    return result.results.map(reviewedDependency);
  }

  async function replaceReviewedDependencies(
    rootName: string,
    expectedEtag: string,
    manifestDigest: string,
    dependencies: ReviewedDependency[],
  ): Promise<CurrentResourceRecord> {
    if (dependencies.length > 500) throw new RangeError('A root may review at most 500 direct dependencies');
    const keys = new Set<string>();
    for (const dependency of dependencies) {
      if (dependency.rootName !== rootName) throw new TypeError('Reviewed dependency root does not match');
      const key = `${dependency.dependencyRole}\0${dependency.dependencyName}`;
      if (keys.has(key)) throw new TypeError(`Duplicate reviewed dependency: ${key}`);
      keys.add(key);
    }

    const stored = await getCurrent(rootName);
    if (!stored) throw new ResourceNotFoundError(rootName);
    if (stored.etag !== expectedEtag) throw new ResourceConflictError(rootName, expectedEtag, stored.etag);
    if (stored.kind !== 'TASK_SOP' && stored.kind !== 'REQUIREMENT') {
      throw new TypeError('Only TaskSop and Requirement roots have reviewed dependencies');
    }
    if (stored.lifecycle !== 'DRAFT') throw new TypeError('Reviewed dependencies can only be acknowledged for a draft');

    const timestamp = now();
    const protoJson = withReviewedDependencyDigest(stored.protoJson, createEtag(), manifestDigest);
    const record = buildCurrent({
      protoSchema: stored.protoSchema,
      protoJson: stored.protoJson,
      now: timestamp,
    }, stored.createdAt, stored.archivedAt, protoJson);
    const normalizedDependencies = dependencies.map((dependency) => ({
      dependencyRole: dependency.dependencyRole,
      dependencyName: dependency.dependencyName,
      dependencyUid: dependency.dependencyUid,
      tokenKind: dependency.tokenKind,
      reviewedToken: dependency.reviewedToken,
      createdAt: dependency.createdAt || timestamp,
    }));

    const statements = [
      db.prepare(`UPDATE SOP_CURRENT_RESOURCES SET reviewed_manifest_digest = ?, etag = ?,
        proto_json = ?, updated_at = ? WHERE name = ? AND etag = ?`).bind(
        record.reviewedManifestDigest ?? null, record.etag, record.protoJson, record.updatedAt,
        rootName, expectedEtag,
      ),
      db.prepare(`DELETE FROM SOP_REVIEWED_DEPENDENCIES
        WHERE root_name = ? AND EXISTS (
          SELECT 1 FROM SOP_CURRENT_RESOURCES WHERE name = ? AND etag = ?
        )`).bind(rootName, rootName, record.etag),
      db.prepare(`INSERT INTO SOP_REVIEWED_DEPENDENCIES (
        root_name, dependency_role, dependency_name, dependency_uid,
        token_kind, reviewed_token, created_at
      )
      SELECT ?,
        json_extract(value, '$.dependencyRole'),
        json_extract(value, '$.dependencyName'),
        json_extract(value, '$.dependencyUid'),
        json_extract(value, '$.tokenKind'),
        json_extract(value, '$.reviewedToken'),
        json_extract(value, '$.createdAt')
      FROM json_each(?)
      WHERE EXISTS (
        SELECT 1 FROM SOP_CURRENT_RESOURCES WHERE name = ? AND etag = ?
      )`).bind(rootName, JSON.stringify(normalizedDependencies), rootName, record.etag),
    ];
    const results = await db.batch(statements);
    if (changes(results[0]) !== 1) return stale(rootName, expectedEtag, 'SOP_CURRENT_RESOURCES');
    return record;
  }

  async function readIdempotentConfirmation(
    root: CurrentResourceRecord,
    expectedRevision: RevisionRecord,
    expectedBundle: ExportBundleRecord,
  ): Promise<AtomicConfirmationResult | undefined> {
    if (root.lifecycle !== 'CONFIRMED' || root.currentRevisionName !== expectedRevision.name) return undefined;
    const [revision, bundle] = await Promise.all([
      getRevision(expectedRevision.name),
      getExportBundle(expectedRevision.name),
    ]);
    if (!revision || !bundle) return undefined;
    if (
      revision.uid !== expectedRevision.uid
      || revision.ownerName !== expectedRevision.ownerName
      || revision.versionSequence !== expectedRevision.versionSequence
      || revision.confirmationCommandId !== expectedRevision.confirmationCommandId
      || revision.confirmedFromEtag !== expectedRevision.confirmedFromEtag
      || bundle.rootKind !== expectedBundle.rootKind
      || bundle.contentSha256 !== expectedBundle.contentSha256
    ) return undefined;
    return { root, revision, bundle, idempotent: true };
  }

  async function readIdempotentRobotSave(
    root: CurrentResourceRecord,
    expectedRevision: RevisionRecord,
  ): Promise<AtomicRobotModelSaveResult | undefined> {
    if (root.kind !== 'ROBOT_MODEL' || root.currentRevisionName !== expectedRevision.name) return undefined;
    const revision = await getRevision(expectedRevision.name);
    if (!revision || revision.kind !== 'ROBOT_MODEL_REVISION' ||
      revision.uid !== expectedRevision.uid || revision.ownerName !== root.name ||
      revision.versionSequence !== expectedRevision.versionSequence ||
      revision.protoSchema !== expectedRevision.protoSchema ||
      revision.revisionProtoJson !== expectedRevision.revisionProtoJson ||
      revision.frozenDependenciesProtoJson !== expectedRevision.frozenDependenciesProtoJson) return undefined;
    return { root, revision, idempotent: true };
  }

  async function createRobotModel(input: AtomicRobotModelCreateInput): Promise<AtomicRobotModelSaveResult> {
    const createdAt = input.current.now ?? now();
    const root = buildCurrent(input.current, createdAt);
    const revision = buildRevision(input.revision);
    const invalid: string[] = [];
    if (root.kind !== 'ROBOT_MODEL' || root.lifecycle !== 'ACTIVE') invalid.push('root.kind');
    if (root.currentRevisionName !== revision.name) invalid.push('currentRevisionName');
    if (revision.kind !== 'ROBOT_MODEL_REVISION' || revision.ownerName !== root.name) invalid.push('revision.ownerName');
    if (revision.versionSequence !== 1 || revision.previousRevisionName !== undefined) invalid.push('revision.sequence');
    if (revision.lifecycle !== 'CONFIRMED' || revision.exportEligible) invalid.push('revision.lifecycle');
    if (invalid.length > 0) projectionError(root.name, invalid);

    // The root and its first immutable revision form one aggregate. The
    // physical pointer is filled only after the revision exists; D1 batch
    // atomicity keeps that temporary state invisible and rolls everything
    // back on a duplicate identity or failed guard.
    const results = await db.batch([
      db.prepare(`INSERT INTO SOP_CURRENT_RESOURCES (
        name, uid, kind, source_id, display_name, scene_name, customer_name,
        robot_model_revision_name, project_display_name, deadline, production_item_count, aggregate_duration,
        lifecycle, candidate_version_sequence,
        candidate_version_label, candidate_source_version_id, current_revision_name,
        reviewed_manifest_digest, etag, proto_schema, proto_json, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`).bind(
        root.name, root.uid, root.kind, root.sourceId ?? null, root.displayName,
        root.sceneName ?? null, root.customerName ?? null, root.robotModelRevisionName ?? null,
        root.projectDisplayName ?? null, root.deadline ?? null, root.productionItemCount ?? null,
        root.aggregateDuration ?? null,
        root.lifecycle, root.candidateVersionSequence ?? null, root.candidateVersionLabel ?? null,
        root.candidateSourceVersionId ?? null, root.reviewedManifestDigest ?? null, root.etag,
        root.protoSchema, root.protoJson, root.archivedAt ?? null, root.createdAt, root.updatedAt,
      ),
      db.prepare(`INSERT INTO SOP_REVISIONS (
        name, uid, owner_name, kind, version_sequence, version_label, previous_revision_name,
        revision_origin, lifecycle, export_eligible, confirmation_command_id, confirmed_from_etag,
        proto_schema, revision_proto_json, frozen_dependencies_proto_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        revision.name, revision.uid, revision.ownerName, revision.kind, revision.versionSequence,
        revision.versionLabel, revision.previousRevisionName ?? null, revision.revisionOrigin,
        revision.lifecycle, revision.exportEligible ? 1 : 0,
        revision.confirmationCommandId ?? null, revision.confirmedFromEtag ?? null, revision.protoSchema,
        revision.revisionProtoJson, revision.frozenDependenciesProtoJson ?? null, revision.createdAt,
      ),
      db.prepare(`UPDATE SOP_CURRENT_RESOURCES SET current_revision_name = ?
        WHERE name = ? AND etag = ?`).bind(revision.name, root.name, root.etag),
    ]);
    if (changes(results[0]) !== 1 || changes(results[1]) !== 1 || changes(results[2]) !== 1) {
      throw new Error('RobotModel creation batch completed without the guarded revision pointer');
    }
    return { root, revision, idempotent: false };
  }

  async function saveRobotModel(input: AtomicRobotModelSaveInput): Promise<AtomicRobotModelSaveResult> {
    const stored = await getCurrent(input.rootName);
    if (!stored) throw new ResourceNotFoundError(input.rootName);
    const revision = buildRevision(input.revision);
    const idempotent = await readIdempotentRobotSave(stored, revision);
    if (idempotent) return idempotent;
    if (stored.kind !== 'ROBOT_MODEL' || stored.lifecycle !== 'ACTIVE') {
      throw new TypeError('Only an active RobotModel can append a revision');
    }
    if (stored.etag !== input.expectedEtag) {
      throw new ResourceConflictError(input.rootName, input.expectedEtag, stored.etag);
    }
    const root = buildCurrent(input.current, stored.createdAt, stored.archivedAt);
    const invalid: string[] = [];
    if (root.name !== stored.name || root.uid !== stored.uid || root.kind !== 'ROBOT_MODEL') invalid.push('rootIdentity');
    if (root.lifecycle !== 'ACTIVE') invalid.push('lifecycle');
    if (root.currentRevisionName !== revision.name) invalid.push('currentRevisionName');
    if (revision.kind !== 'ROBOT_MODEL_REVISION' || revision.ownerName !== root.name) invalid.push('revision.ownerName');
    if (revision.lifecycle !== 'CONFIRMED' || revision.exportEligible) invalid.push('revision.lifecycle');
    if (invalid.length > 0) projectionError(input.rootName, invalid);

    // The first conditional update claims the root etag but temporarily keeps
    // the old physical pointer. The batch then inserts the immutable revision
    // only if that claim succeeded and finally advances the pointer. D1 batch
    // atomicity prevents the temporary projection from becoming observable.
    const results = await db.batch([
      db.prepare(`UPDATE SOP_CURRENT_RESOURCES SET
        source_id = ?, display_name = ?, scene_name = ?, customer_name = ?,
        robot_model_revision_name = ?, project_display_name = ?, deadline = ?, production_item_count = ?,
        aggregate_duration = ?, lifecycle = ?, candidate_version_sequence = ?,
        candidate_version_label = ?, candidate_source_version_id = ?,
        reviewed_manifest_digest = ?, etag = ?, proto_schema = ?, proto_json = ?, archived_at = ?, updated_at = ?
      WHERE name = ? AND etag = ?`).bind(
        root.sourceId ?? null, root.displayName, root.sceneName ?? null, root.customerName ?? null,
        root.robotModelRevisionName ?? null, root.projectDisplayName ?? null, root.deadline ?? null,
        root.productionItemCount ?? null, root.aggregateDuration ?? null,
        root.lifecycle, root.candidateVersionSequence ?? null,
        root.candidateVersionLabel ?? null, root.candidateSourceVersionId ?? null,
        root.reviewedManifestDigest ?? null, root.etag, root.protoSchema, root.protoJson,
        root.archivedAt ?? null, root.updatedAt, input.rootName, input.expectedEtag,
      ),
      db.prepare(`INSERT INTO SOP_REVISIONS (
        name, uid, owner_name, kind, version_sequence, version_label, previous_revision_name,
        revision_origin, lifecycle, export_eligible, proto_schema, revision_proto_json,
        frozen_dependencies_proto_json, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM SOP_CURRENT_RESOURCES WHERE name = ? AND etag = ?)`).bind(
        revision.name, revision.uid, revision.ownerName, revision.kind, revision.versionSequence,
        revision.versionLabel, revision.previousRevisionName ?? null, revision.revisionOrigin,
        revision.lifecycle, revision.exportEligible ? 1 : 0, revision.protoSchema,
        revision.revisionProtoJson, revision.frozenDependenciesProtoJson ?? null, revision.createdAt,
        input.rootName, root.etag,
      ),
      db.prepare(`UPDATE SOP_CURRENT_RESOURCES SET current_revision_name = ?
        WHERE name = ? AND etag = ?`).bind(revision.name, input.rootName, root.etag),
    ]);
    if (changes(results[0]) === 1 && changes(results[1]) === 1 && changes(results[2]) === 1) {
      return { root, revision, idempotent: false };
    }
    const latest = await getCurrent(input.rootName);
    if (latest) {
      const retry = await readIdempotentRobotSave(latest, revision);
      if (retry) return retry;
      throw new ResourceConflictError(input.rootName, input.expectedEtag, latest.etag);
    }
    throw new ResourceNotFoundError(input.rootName);
  }

  async function confirm(input: AtomicConfirmationInput): Promise<AtomicConfirmationResult> {
    const stored = await getCurrent(input.rootName);
    if (!stored) throw new ResourceNotFoundError(input.rootName);
    const revision = buildRevision({
      ...input.revision,
      confirmationCommandId: input.commandId,
      confirmedFromEtag: input.expectedEtag,
    });
    const bundle = buildBundle(input.bundle);

    const idempotent = await readIdempotentConfirmation(stored, revision, bundle);
    if (idempotent) return idempotent;
    if (stored.lifecycle !== 'DRAFT') throw new TypeError('Only a current draft can be confirmed');
    if (stored.etag !== input.expectedEtag) {
      throw new ResourceConflictError(input.rootName, input.expectedEtag, stored.etag);
    }

    const root = buildCurrent(input.confirmedRoot, stored.createdAt, stored.archivedAt);
    const invalid: string[] = [];
    if (root.name !== input.rootName || root.uid !== stored.uid || root.kind !== stored.kind) invalid.push('rootIdentity');
    if (root.lifecycle !== 'CONFIRMED') invalid.push('lifecycle');
    if (root.currentRevisionName !== revision.name) invalid.push('currentRevisionName');
    if (root.reviewedManifestDigest !== input.reviewedManifestDigest) invalid.push('reviewedManifestDigest');
    if (revision.ownerName !== root.name) invalid.push('revision.ownerName');
    if (revision.lifecycle !== 'CONFIRMED' || revision.revisionOrigin === 'IMPORTED_DRAFT_CHECKPOINT') {
      invalid.push('revision.lifecycle');
    }
    if (!revision.exportEligible) invalid.push('revision.exportEligible');
    if (stored.candidateVersionSequence !== revision.versionSequence) invalid.push('revision.versionSequence');
    if (stored.candidateVersionLabel !== revision.versionLabel) invalid.push('revision.versionLabel');
    if (bundle.rootRevisionName !== revision.name) invalid.push('bundle.rootRevisionName');
    if (
      (root.kind === 'TASK_SOP' && bundle.rootKind !== 'TASK_SOP')
      || (root.kind === 'REQUIREMENT' && bundle.rootKind !== 'REQUIREMENT')
      || root.kind === 'ROBOT_MODEL'
    ) invalid.push('bundle.rootKind');
    if (invalid.length > 0) projectionError(input.rootName, invalid);

    const commandCreatedAt = now();
    const statements = [
      db.prepare(`INSERT INTO SOP_CONFIRMATION_COMMANDS (
        command_id, root_name, expected_etag, reviewed_manifest_digest, target_revision_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`).bind(
        input.commandId, input.rootName, input.expectedEtag, input.reviewedManifestDigest,
        revision.name, commandCreatedAt,
      ),
      db.prepare(`INSERT INTO SOP_REVISIONS (
        name, uid, owner_name, kind, version_sequence, version_label, previous_revision_name,
        revision_origin, lifecycle, export_eligible, confirmation_command_id, confirmed_from_etag,
        proto_schema, revision_proto_json, frozen_dependencies_proto_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        revision.name, revision.uid, revision.ownerName, revision.kind, revision.versionSequence,
        revision.versionLabel, revision.previousRevisionName ?? null, revision.revisionOrigin,
        revision.lifecycle, revision.exportEligible ? 1 : 0,
        revision.confirmationCommandId ?? null, revision.confirmedFromEtag ?? null, revision.protoSchema,
        revision.revisionProtoJson, revision.frozenDependenciesProtoJson ?? null, revision.createdAt,
      ),
      db.prepare(`INSERT INTO SOP_EXPORT_BUNDLES (
        root_revision_name, root_kind, schema_version, renderer_version, content_size_bytes,
        content_sha256, proto_schema, bundle_proto_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        bundle.rootRevisionName, bundle.rootKind, bundle.schemaVersion, bundle.rendererVersion,
        bundle.contentSizeBytes, bundle.contentSha256, bundle.protoSchema, bundle.bundleProtoJson,
        bundle.createdAt,
      ),
      db.prepare(`UPDATE SOP_CURRENT_RESOURCES SET
        source_id = ?, display_name = ?, scene_name = ?, customer_name = ?,
        robot_model_revision_name = ?, project_display_name = ?, deadline = ?, production_item_count = ?,
        aggregate_duration = ?, lifecycle = ?, candidate_version_sequence = ?,
        candidate_version_label = ?, candidate_source_version_id = ?, current_revision_name = ?,
        reviewed_manifest_digest = ?, etag = ?, proto_schema = ?, proto_json = ?, archived_at = ?, updated_at = ?
      WHERE name = ? AND etag = ? AND EXISTS (
        SELECT 1 FROM SOP_CONFIRMATION_COMMANDS WHERE command_id = ? AND root_name = ?
      )`).bind(
        root.sourceId ?? null, root.displayName, root.sceneName ?? null, root.customerName ?? null,
        root.robotModelRevisionName ?? null, root.projectDisplayName ?? null, root.deadline ?? null,
        root.productionItemCount ?? null, root.aggregateDuration ?? null,
        root.lifecycle, root.candidateVersionSequence ?? null,
        root.candidateVersionLabel ?? null, root.candidateSourceVersionId ?? null,
        root.currentRevisionName ?? null, root.reviewedManifestDigest ?? null, root.etag,
        root.protoSchema, root.protoJson, root.archivedAt ?? null, root.updatedAt,
        input.rootName, input.expectedEtag, input.commandId, input.rootName,
      ),
      db.prepare(`DELETE FROM SOP_CONFIRMATION_COMMANDS WHERE command_id = ?`).bind(input.commandId),
    ];

    try {
      const results = await db.batch(statements);
      if (changes(results[3]) !== 1 || changes(results[4]) !== 1) {
        throw new Error('Confirmation batch completed without the guarded root transition');
      }
      return { root, revision, bundle, idempotent: false };
    } catch (error) {
      const latest = await getCurrent(input.rootName);
      if (latest) {
        const retryResult = await readIdempotentConfirmation(latest, revision, bundle);
        if (retryResult) return retryResult;
        if (latest.etag !== input.expectedEtag) {
          throw new ResourceConflictError(input.rootName, input.expectedEtag, latest.etag);
        }
      }
      throw error;
    }
  }

  async function getMeta(key: string): Promise<MetaRecord | undefined> {
    const row = await db.prepare('SELECT key, value, updated_at FROM SOP_META WHERE key = ?')
      .bind(key).first<MetaRow>();
    return row ? metaRecord(row) : undefined;
  }

  async function compareAndSetMeta(input: MetaCompareAndSetInput): Promise<boolean> {
    const timestamp = input.now ?? now();
    const result = input.expectedValue === undefined
      ? await db.prepare(`INSERT INTO SOP_META (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO NOTHING`).bind(input.key, input.nextValue, timestamp).run()
      : await db.prepare(`UPDATE SOP_META SET value = ?, updated_at = ?
          WHERE key = ? AND value = ?`).bind(input.nextValue, timestamp, input.key, input.expectedValue).run();
    return changes(result) === 1;
  }

  async function assertMeta(key: string, expectedValue: string): Promise<MetaRecord> {
    const meta = await getMeta(key);
    if (!meta || meta.value !== expectedValue) {
      throw new RepositoryNotReadyError(key, expectedValue, meta?.value);
    }
    return meta;
  }

  async function auditPayloadPages<Row>(input: {
    columns: string;
    table: string;
    keyColumn: string;
    key(row: Row): string;
    validate(row: Row): void;
  }): Promise<void> {
    let cursor = '';
    while (true) {
      const page = await db.prepare(`SELECT ${input.columns} FROM ${input.table}
        WHERE ${input.keyColumn} > ?
        ORDER BY ${input.keyColumn} ASC LIMIT ?`)
        .bind(cursor, PROJECTION_AUDIT_PAGE_SIZE).all<Row>();
      for (const row of page.results) input.validate(row);
      if (page.results.length < PROJECTION_AUDIT_PAGE_SIZE) return;
      const nextCursor = input.key(page.results.at(-1)!);
      if (!nextCursor || nextCursor <= cursor) throw new Error(`Projection audit cursor did not advance for ${input.table}`);
      cursor = nextCursor;
    }
  }

  async function auditRelationalIntegrity(): Promise<void> {
    const invalidCurrentRevision = await db.prepare(`SELECT
        current.name, current.kind, current.current_revision_name,
        revision.name AS revision_name, revision.kind AS revision_kind,
        CASE current.kind
          WHEN 'TASK_SOP' THEN 'TASK_SOP_REVISION'
          WHEN 'REQUIREMENT' THEN 'REQUIREMENT_REVISION'
        END AS expected_revision_kind
      FROM SOP_CURRENT_RESOURCES AS current
      LEFT JOIN SOP_REVISIONS AS revision ON revision.name = current.current_revision_name
      WHERE current.lifecycle = 'CONFIRMED'
        AND current.kind IN ('TASK_SOP', 'REQUIREMENT')
        AND (
          revision.name IS NULL
          OR revision.owner_name <> current.name
          OR revision.kind <> CASE current.kind
            WHEN 'TASK_SOP' THEN 'TASK_SOP_REVISION'
            WHEN 'REQUIREMENT' THEN 'REQUIREMENT_REVISION'
          END
          OR revision.lifecycle <> 'CONFIRMED'
          OR revision.export_eligible <> 1
          OR revision.revision_origin = 'IMPORTED_DRAFT_CHECKPOINT'
        )
      ORDER BY current.name ASC LIMIT 1`).first<{
        name: string;
        current_revision_name: string | null;
        revision_kind: string | null;
        expected_revision_kind: string;
      }>();
    if (invalidCurrentRevision) {
      failIntegrity(
        `current.${invalidCurrentRevision.name}.revision`,
        `eligible ${invalidCurrentRevision.expected_revision_kind} owned by ${invalidCurrentRevision.name}`,
        invalidCurrentRevision.current_revision_name ?? invalidCurrentRevision.revision_kind ?? '<missing>',
      );
    }

    const invalidCurrentBundle = await db.prepare(`SELECT
        current.name, revision.name AS revision_name,
        bundle.root_kind AS actual_root_kind,
        CASE current.kind WHEN 'TASK_SOP' THEN 'TASK_SOP' ELSE 'REQUIREMENT' END AS expected_root_kind
      FROM SOP_CURRENT_RESOURCES AS current
      JOIN SOP_REVISIONS AS revision ON revision.name = current.current_revision_name
      LEFT JOIN SOP_EXPORT_BUNDLES AS bundle ON bundle.root_revision_name = revision.name
      WHERE current.lifecycle = 'CONFIRMED'
        AND current.kind IN ('TASK_SOP', 'REQUIREMENT')
        AND (
          bundle.root_revision_name IS NULL
          OR bundle.root_kind <> CASE current.kind WHEN 'TASK_SOP' THEN 'TASK_SOP' ELSE 'REQUIREMENT' END
        )
      ORDER BY current.name ASC LIMIT 1`).first<{
        name: string;
        revision_name: string;
        actual_root_kind: string | null;
        expected_root_kind: string;
      }>();
    if (invalidCurrentBundle) {
      failIntegrity(
        `current.${invalidCurrentBundle.name}.bundle`,
        `${invalidCurrentBundle.expected_root_kind} bundle for ${invalidCurrentBundle.revision_name}`,
        invalidCurrentBundle.actual_root_kind ?? '<missing>',
      );
    }

    const invalidRevisionBundle = await db.prepare(`SELECT
        revision.name, bundle.root_kind,
        CASE WHEN revision.kind IN ('TASK_SOP_REVISION', 'REQUIREMENT_REVISION')
          AND revision.lifecycle = 'CONFIRMED'
          AND revision.export_eligible = 1
          AND revision.revision_origin <> 'IMPORTED_DRAFT_CHECKPOINT'
        THEN 1 ELSE 0 END AS eligible
      FROM SOP_REVISIONS AS revision
      LEFT JOIN SOP_EXPORT_BUNDLES AS bundle ON bundle.root_revision_name = revision.name
      WHERE (
        revision.kind IN ('TASK_SOP_REVISION', 'REQUIREMENT_REVISION')
        AND revision.lifecycle = 'CONFIRMED'
        AND revision.export_eligible = 1
        AND revision.revision_origin <> 'IMPORTED_DRAFT_CHECKPOINT'
        AND bundle.root_revision_name IS NULL
      ) OR (
        NOT (
          revision.kind IN ('TASK_SOP_REVISION', 'REQUIREMENT_REVISION')
          AND revision.lifecycle = 'CONFIRMED'
          AND revision.export_eligible = 1
          AND revision.revision_origin <> 'IMPORTED_DRAFT_CHECKPOINT'
        )
        AND bundle.root_revision_name IS NOT NULL
      )
      ORDER BY revision.name ASC LIMIT 1`).first<{
        name: string;
        root_kind: string | null;
        eligible: number;
      }>();
    if (invalidRevisionBundle) {
      failIntegrity(
        `revision.${invalidRevisionBundle.name}.bundle`,
        invalidRevisionBundle.eligible === 1 ? 'exactly one sealed export bundle' : 'no sealed export bundle',
        invalidRevisionBundle.root_kind ?? '<missing>',
      );
    }

    const invalidBundleRevision = await db.prepare(`SELECT
        bundle.root_revision_name, bundle.root_kind, revision.kind AS revision_kind
      FROM SOP_EXPORT_BUNDLES AS bundle
      LEFT JOIN SOP_REVISIONS AS revision ON revision.name = bundle.root_revision_name
      WHERE revision.name IS NULL
        OR revision.kind <> CASE bundle.root_kind
          WHEN 'TASK_SOP' THEN 'TASK_SOP_REVISION'
          ELSE 'REQUIREMENT_REVISION'
        END
        OR revision.lifecycle <> 'CONFIRMED'
        OR revision.export_eligible <> 1
        OR revision.revision_origin = 'IMPORTED_DRAFT_CHECKPOINT'
      ORDER BY bundle.root_revision_name ASC LIMIT 1`).first<{
        root_revision_name: string;
        root_kind: ExportBundleRecord['rootKind'];
        revision_kind: string | null;
      }>();
    if (invalidBundleRevision) {
      const requiredKind = invalidBundleRevision.root_kind === 'TASK_SOP'
        ? 'TASK_SOP_REVISION'
        : 'REQUIREMENT_REVISION';
      failIntegrity(
        `bundle.${invalidBundleRevision.root_revision_name}.revision`,
        `eligible ${requiredKind}`,
        invalidBundleRevision.revision_kind ?? '<missing>',
      );
    }

    const invalidDependencyRoot = await db.prepare(`SELECT
        dependency.root_name, current.kind AS root_kind
      FROM SOP_REVIEWED_DEPENDENCIES AS dependency
      LEFT JOIN SOP_CURRENT_RESOURCES AS current ON current.name = dependency.root_name
      WHERE current.name IS NULL OR current.kind NOT IN ('TASK_SOP', 'REQUIREMENT')
      ORDER BY dependency.root_name ASC LIMIT 1`).first<{
        root_name: string;
        root_kind: string | null;
      }>();
    if (invalidDependencyRoot) {
      failIntegrity(
        `reviewedDependency.${invalidDependencyRoot.root_name}.root`,
        'existing TaskSop or Requirement root',
        invalidDependencyRoot.root_kind ?? '<missing>',
      );
    }

    const excessiveDependencies = await db.prepare(`SELECT root_name, count(*) AS dependency_count
      FROM SOP_REVIEWED_DEPENDENCIES
      GROUP BY root_name HAVING count(*) > 500
      ORDER BY root_name ASC LIMIT 1`).first<{ root_name: string; dependency_count: number }>();
    if (excessiveDependencies) {
      failIntegrity(
        `reviewedDependency.${excessiveDependencies.root_name}.count`,
        'at most 500',
        String(excessiveDependencies.dependency_count),
      );
    }
  }

  async function auditProjectionParity(): Promise<void> {
    await auditPayloadPages<CatalogRow>({
      columns: CATALOG_DETAIL_COLUMNS,
      table: 'SOP_CATALOG_RESOURCES',
      keyColumn: 'name',
      key: (row) => row.name,
      validate: assertCatalogParity,
    });
    await auditPayloadPages<CurrentRow>({
      columns: CURRENT_DETAIL_COLUMNS,
      table: 'SOP_CURRENT_RESOURCES',
      keyColumn: 'name',
      key: (row) => row.name,
      validate: assertCurrentParity,
    });
    await auditPayloadPages<RevisionRow>({
      columns: REVISION_DETAIL_COLUMNS,
      table: 'SOP_REVISIONS',
      keyColumn: 'name',
      key: (row) => row.name,
      validate: assertRevisionParity,
    });
    await auditPayloadPages<BundleRow>({
      columns: BUNDLE_DETAIL_COLUMNS,
      table: 'SOP_EXPORT_BUNDLES',
      keyColumn: 'root_revision_name',
      key: (row) => row.root_revision_name,
      validate(row) {
        assertBundleParity(row);
        try {
          decodeExportBundle(row.bundle_proto_json);
        } catch (error) {
          failIntegrity(
            `bundle.${row.root_revision_name}.content`,
            'valid sealed content hash and size',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });
    await auditRelationalIntegrity();
  }

  return {
    getCatalog,
    getCatalogs,
    listCatalog,
    createCatalog,
    updateCatalog: (name, expectedEtag, input) => writeCatalog(name, expectedEtag, input, false),
    archiveCatalog: (name, expectedEtag, input) => writeCatalog(name, expectedEtag, input, true),
    replaceGlobalFields,
    getCurrent,
    getCurrentByUid,
    getCurrents,
    listCurrent,
    listArchivedCurrent,
    createCurrent,
    updateCurrent: (name, expectedEtag, input) => writeCurrent(name, expectedEtag, input, false),
    archiveCurrent: (name, expectedEtag, input) => writeCurrent(name, expectedEtag, input, true),
    archiveCurrentForLibrary,
    restoreCurrentFromLibrary,
    findActiveRequirementReferrers,
    getRevision,
    getRevisionByUid,
    getRevisions,
    listRevisions,
    createRevision,
    getExportBundle,
    createExportBundle,
    loadReviewedDependencies,
    replaceReviewedDependencies,
    createRobotModel,
    saveRobotModel,
    confirm,
    getMeta,
    compareAndSetMeta,
    assertMeta,
    auditProjectionParity,
  };
}
