import type {
  AtomicConfirmationInput,
  AtomicConfirmationResult,
  CatalogResourceKind,
  CatalogResourceRecord,
  CurrentResourceKind,
  CurrentResourceRecord,
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
  ProjectionMismatchError,
  RepositoryNotReadyError,
  ResourceConflictError,
  ResourceNotFoundError,
} from '../domain/repository';
import { guardProspectiveRow, type RowSizeWarning, type VariableLengthValue } from '../domain/rowSize';
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

const CATALOG_DETAIL_COLUMNS = `name, uid, kind, source_id, display_name, etag,
  proto_schema, proto_json, archived_at, created_at, updated_at`;
const CURRENT_DETAIL_COLUMNS = `name, uid, kind, source_id, display_name, lifecycle,
  candidate_version_sequence, candidate_version_label, candidate_source_version_id, current_revision_name,
  reviewed_manifest_digest, etag, proto_schema, proto_json, archived_at, created_at, updated_at`;
const REVISION_DETAIL_COLUMNS = `name, uid, owner_name, kind, version_sequence, version_label,
  previous_revision_name, revision_origin, lifecycle, export_eligible, proto_schema,
  revision_proto_json, frozen_dependencies_proto_json, created_at`;
const BUNDLE_DETAIL_COLUMNS = `root_revision_name, root_kind, schema_version, renderer_version,
  content_size_bytes, content_sha256, proto_schema, bundle_proto_json, created_at`;

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

function encodeCursor(name: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, name }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeCursor(cursor?: string): string {
  if (!cursor) return '';
  try {
    const standard = cursor.replaceAll('-', '+').replaceAll('_', '/');
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown; name?: unknown };
    if (value.version !== 1 || typeof value.name !== 'string' || value.name === '') throw new Error('invalid');
    return value.name;
  } catch {
    throw new InvalidCursorError();
  }
}

function pageLimit(request?: PageRequest): number {
  const requested = request?.limit ?? 100;
  if (!Number.isInteger(requested) || requested <= 0) throw new RangeError('Page limit must be a positive integer');
  return Math.min(requested, 200);
}

function toPage<T extends { name: string }>(rows: T[], limit: number): PageResult<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    ...(rows.length > limit && items.length > 0 ? { nextCursor: encodeCursor(items.at(-1)!.name) } : {}),
  };
}

function catalogRecord(row: CatalogRow): CatalogResourceRecord {
  return {
    name: row.name,
    uid: row.uid,
    kind: row.kind,
    sourceId: optional(row.source_id),
    displayName: row.display_name,
    etag: row.etag,
    protoSchema: row.proto_schema,
    protoJson: row.proto_json,
    archivedAt: optional(row.archived_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function currentRecord(row: CurrentRow): CurrentResourceRecord {
  return {
    name: row.name,
    uid: row.uid,
    kind: row.kind,
    sourceId: optional(row.source_id),
    displayName: row.display_name,
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
    protoSchema: row.proto_schema,
    revisionProtoJson: row.revision_proto_json,
    frozenDependenciesProtoJson: optional(row.frozen_dependencies_proto_json),
    createdAt: row.created_at,
  };
}

function revisionSummary(row: Omit<RevisionRow,
  'proto_schema' | 'revision_proto_json' | 'frozen_dependencies_proto_json'>): RevisionSummary {
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

function catalogVariableColumns(record: CatalogResourceRecord): Record<string, VariableLengthValue> {
  return {
    name: record.name,
    uid: record.uid,
    kind: record.kind,
    sourceId: record.sourceId,
    displayName: record.displayName,
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
      protoSchema: input.protoSchema,
      revisionProtoJson: input.revisionProtoJson,
      frozenDependenciesProtoJson: input.frozenDependenciesProtoJson,
      createdAt: input.now ?? now(),
    };
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

  async function listCatalog(kind: CatalogResourceKind, page?: PageRequest): Promise<PageResult<ResourceSummary>> {
    const limit = pageLimit(page);
    const cursor = decodeCursor(page?.cursor);
    const result = await db.prepare(`SELECT name, uid, kind, source_id, display_name, etag, archived_at
      FROM SOP_CATALOG_RESOURCES
      WHERE kind = ? AND archived_at IS NULL AND name > ?
      ORDER BY name ASC LIMIT ?`).bind(kind, cursor, limit + 1).all<Pick<CatalogRow,
        'name' | 'uid' | 'kind' | 'source_id' | 'display_name' | 'etag' | 'archived_at'>>();
    return toPage(result.results.map((row) => ({
      name: row.name,
      uid: row.uid,
      kind: row.kind,
      sourceId: optional(row.source_id),
      displayName: row.display_name,
      etag: row.etag,
      archivedAt: optional(row.archived_at),
    })), limit);
  }

  async function createCatalog(input: ResourceWriteInput): Promise<CatalogResourceRecord> {
    const createdAt = input.now ?? now();
    const record = buildCatalog(input, createdAt);
    await db.prepare(`INSERT INTO SOP_CATALOG_RESOURCES (
      name, uid, kind, source_id, display_name, etag, proto_schema, proto_json,
      archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      record.name, record.uid, record.kind, record.sourceId ?? null, record.displayName, record.etag,
      record.protoSchema, record.protoJson, record.archivedAt ?? null, record.createdAt, record.updatedAt,
    ).run();
    return record;
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
      source_id = ?, display_name = ?, etag = ?, proto_schema = ?, proto_json = ?,
      archived_at = ?, updated_at = ?
      WHERE name = ? AND etag = ?`).bind(
      record.sourceId ?? null, record.displayName, record.etag, record.protoSchema, record.protoJson,
      record.archivedAt ?? null, record.updatedAt, name, expectedEtag,
    ).run();
    if (changes(result) !== 1) return stale(name, expectedEtag, 'SOP_CATALOG_RESOURCES');
    return record;
  }

  async function getCurrent(name: string): Promise<CurrentResourceRecord | undefined> {
    const row = await rawCurrent(name);
    if (!row) return undefined;
    assertCurrentParity(row);
    return currentRecord(row);
  }

  async function listCurrent(kind: CurrentResourceKind, page?: PageRequest): Promise<PageResult<ResourceSummary>> {
    const limit = pageLimit(page);
    const cursor = decodeCursor(page?.cursor);
    const result = await db.prepare(`SELECT name, uid, kind, source_id, display_name, lifecycle, etag, archived_at
      FROM SOP_CURRENT_RESOURCES
      WHERE kind = ? AND archived_at IS NULL AND name > ?
      ORDER BY name ASC LIMIT ?`).bind(kind, cursor, limit + 1).all<Pick<CurrentRow,
        'name' | 'uid' | 'kind' | 'source_id' | 'display_name' | 'lifecycle' | 'etag' | 'archived_at'>>();
    return toPage(result.results.map((row) => ({
      name: row.name,
      uid: row.uid,
      kind: row.kind,
      sourceId: optional(row.source_id),
      displayName: row.display_name,
      lifecycle: row.lifecycle,
      etag: row.etag,
      archivedAt: optional(row.archived_at),
    })), limit);
  }

  async function createCurrent(input: CurrentResourceWriteInput): Promise<CurrentResourceRecord> {
    const createdAt = input.now ?? now();
    const record = buildCurrent(input, createdAt);
    await db.prepare(`INSERT INTO SOP_CURRENT_RESOURCES (
      name, uid, kind, source_id, display_name, lifecycle, candidate_version_sequence,
      candidate_version_label, candidate_source_version_id, current_revision_name,
      reviewed_manifest_digest, etag, proto_schema, proto_json, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      record.name, record.uid, record.kind, record.sourceId ?? null, record.displayName, record.lifecycle,
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
      source_id = ?, display_name = ?, lifecycle = ?, candidate_version_sequence = ?,
      candidate_version_label = ?, candidate_source_version_id = ?, current_revision_name = ?,
      reviewed_manifest_digest = ?, etag = ?, proto_schema = ?, proto_json = ?, archived_at = ?, updated_at = ?
      WHERE name = ? AND etag = ?`).bind(
      record.sourceId ?? null, record.displayName, record.lifecycle, record.candidateVersionSequence ?? null,
      record.candidateVersionLabel ?? null, record.candidateSourceVersionId ?? null,
      record.currentRevisionName ?? null, record.reviewedManifestDigest ?? null, record.etag,
      record.protoSchema, record.protoJson, record.archivedAt ?? null, record.updatedAt, name, expectedEtag,
    ).run();
    if (changes(result) !== 1) return stale(name, expectedEtag, 'SOP_CURRENT_RESOURCES');
    return record;
  }

  async function getRevision(name: string): Promise<RevisionRecord | undefined> {
    const row = await rawRevision(name);
    if (!row) return undefined;
    assertRevisionParity(row);
    return revisionRecord(row);
  }

  async function listRevisions(ownerName: string, page?: PageRequest): Promise<PageResult<RevisionSummary>> {
    const limit = pageLimit(page);
    const cursor = decodeCursor(page?.cursor);
    const result = await db.prepare(`SELECT name, uid, owner_name, kind, version_sequence,
      version_label, previous_revision_name, revision_origin, lifecycle, export_eligible, created_at
      FROM SOP_REVISIONS WHERE owner_name = ? AND name > ?
      ORDER BY name ASC LIMIT ?`).bind(ownerName, cursor, limit + 1).all<Omit<RevisionRow,
        'proto_schema' | 'revision_proto_json' | 'frozen_dependencies_proto_json'>>();
    return toPage(result.results.map(revisionSummary), limit);
  }

  async function createRevision(input: RevisionWriteInput): Promise<RevisionRecord> {
    const record = buildRevision(input);
    await db.prepare(`INSERT INTO SOP_REVISIONS (
      name, uid, owner_name, kind, version_sequence, version_label, previous_revision_name,
      revision_origin, lifecycle, export_eligible, proto_schema, revision_proto_json,
      frozen_dependencies_proto_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      record.name, record.uid, record.ownerName, record.kind, record.versionSequence, record.versionLabel,
      record.previousRevisionName ?? null, record.revisionOrigin, record.lifecycle,
      record.exportEligible ? 1 : 0, record.protoSchema, record.revisionProtoJson,
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
      || bundle.rootKind !== expectedBundle.rootKind
      || bundle.contentSha256 !== expectedBundle.contentSha256
    ) return undefined;
    return { root, revision, bundle, idempotent: true };
  }

  async function confirm(input: AtomicConfirmationInput): Promise<AtomicConfirmationResult> {
    const stored = await getCurrent(input.rootName);
    if (!stored) throw new ResourceNotFoundError(input.rootName);
    const revision = buildRevision(input.revision);
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
        revision_origin, lifecycle, export_eligible, proto_schema, revision_proto_json,
        frozen_dependencies_proto_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        revision.name, revision.uid, revision.ownerName, revision.kind, revision.versionSequence,
        revision.versionLabel, revision.previousRevisionName ?? null, revision.revisionOrigin,
        revision.lifecycle, revision.exportEligible ? 1 : 0, revision.protoSchema,
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
        source_id = ?, display_name = ?, lifecycle = ?, candidate_version_sequence = ?,
        candidate_version_label = ?, candidate_source_version_id = ?, current_revision_name = ?,
        reviewed_manifest_digest = ?, etag = ?, proto_schema = ?, proto_json = ?, archived_at = ?, updated_at = ?
      WHERE name = ? AND etag = ? AND EXISTS (
        SELECT 1 FROM SOP_CONFIRMATION_COMMANDS WHERE command_id = ? AND root_name = ?
      )`).bind(
        root.sourceId ?? null, root.displayName, root.lifecycle, root.candidateVersionSequence ?? null,
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

  async function auditProjectionParity(): Promise<void> {
    const [catalog, current, revisions, bundles] = await Promise.all([
      db.prepare(`SELECT ${CATALOG_DETAIL_COLUMNS} FROM SOP_CATALOG_RESOURCES`).all<CatalogRow>(),
      db.prepare(`SELECT ${CURRENT_DETAIL_COLUMNS} FROM SOP_CURRENT_RESOURCES`).all<CurrentRow>(),
      db.prepare(`SELECT ${REVISION_DETAIL_COLUMNS} FROM SOP_REVISIONS`).all<RevisionRow>(),
      db.prepare(`SELECT ${BUNDLE_DETAIL_COLUMNS} FROM SOP_EXPORT_BUNDLES`).all<BundleRow>(),
    ]);
    for (const row of catalog.results) assertCatalogParity(row);
    for (const row of current.results) assertCurrentParity(row);
    for (const row of revisions.results) assertRevisionParity(row);
    for (const row of bundles.results) assertBundleParity(row);
  }

  return {
    getCatalog,
    listCatalog,
    createCatalog,
    updateCatalog: (name, expectedEtag, input) => writeCatalog(name, expectedEtag, input, false),
    archiveCatalog: (name, expectedEtag, input) => writeCatalog(name, expectedEtag, input, true),
    getCurrent,
    listCurrent,
    createCurrent,
    updateCurrent: (name, expectedEtag, input) => writeCurrent(name, expectedEtag, input, false),
    archiveCurrent: (name, expectedEtag, input) => writeCurrent(name, expectedEtag, input, true),
    getRevision,
    listRevisions,
    createRevision,
    getExportBundle,
    createExportBundle,
    loadReviewedDependencies,
    replaceReviewedDependencies,
    confirm,
    getMeta,
    compareAndSetMeta,
    assertMeta,
    auditProjectionParity,
  };
}
