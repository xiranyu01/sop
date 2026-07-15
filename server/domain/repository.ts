export type CatalogResourceKind =
  | 'CUSTOMER'
  | 'MATERIAL'
  | 'SCENE'
  | 'GLOBAL_FIELD'
  | 'MATERIAL_STATE_RULE'
  | 'ATTACHMENT';

export type CurrentResourceKind = 'ROBOT_MODEL' | 'TASK_SOP' | 'REQUIREMENT';
export type RevisionKind = 'ROBOT_MODEL_REVISION' | 'TASK_SOP_REVISION' | 'REQUIREMENT_REVISION';
export type CurrentLifecycle = 'ACTIVE' | 'DRAFT' | 'CONFIRMED' | 'ARCHIVED';
export type RevisionOrigin = 'RUNTIME_CONFIRMED' | 'IMPORTED_CONFIRMED' | 'IMPORTED_DRAFT_CHECKPOINT';

export type ResourceSummary = {
  name: string;
  uid: string;
  kind: CatalogResourceKind | CurrentResourceKind;
  sourceId?: string;
  displayName: string;
  etag: string;
  lifecycle?: CurrentLifecycle;
  archivedAt?: string;
  sku?: string;
  fieldGroup?: string;
  fieldStatus?: string;
  sceneName?: string;
  customerName?: string;
  robotModelRevisionName?: string;
  candidateVersionLabel?: string;
  currentVersionLabel?: string;
  projectDisplayName?: string;
  deadline?: string;
  productionItemCount?: number;
  aggregateDuration?: string;
  currentRevisionName?: string;
};

export type CatalogResourceRecord = ResourceSummary & {
  kind: CatalogResourceKind;
  protoSchema: string;
  protoJson: string;
  createdAt: string;
  updatedAt: string;
};

export type CurrentResourceRecord = ResourceSummary & {
  kind: CurrentResourceKind;
  lifecycle: CurrentLifecycle;
  candidateVersionSequence?: number;
  candidateSourceVersionId?: string;
  reviewedManifestDigest?: string;
  protoSchema: string;
  protoJson: string;
  createdAt: string;
  updatedAt: string;
};

export type RevisionRecord = {
  name: string;
  uid: string;
  ownerName: string;
  kind: RevisionKind;
  versionSequence: number;
  versionLabel: string;
  previousRevisionName?: string;
  revisionOrigin: RevisionOrigin;
  lifecycle: 'DRAFT' | 'CONFIRMED';
  exportEligible: boolean;
  /** Durable response-loss receipt for runtime root confirmation only. */
  confirmationCommandId?: string;
  confirmedFromEtag?: string;
  protoSchema: string;
  revisionProtoJson: string;
  frozenDependenciesProtoJson?: string;
  createdAt: string;
};

export type RevisionSummary = Omit<RevisionRecord,
  'confirmationCommandId' | 'confirmedFromEtag' | 'protoSchema' | 'revisionProtoJson' | 'frozenDependenciesProtoJson'>;

export type ExportBundleRecord = {
  rootRevisionName: string;
  rootKind: 'TASK_SOP' | 'REQUIREMENT';
  schemaVersion: string;
  rendererVersion: string;
  contentSizeBytes: number;
  contentSha256: string;
  protoSchema: string;
  bundleProtoJson: string;
  createdAt: string;
};

export type ReviewedDependency = {
  rootName: string;
  dependencyRole: string;
  dependencyName: string;
  dependencyUid: string;
  tokenKind: 'ETAG' | 'REVISION_UID';
  reviewedToken: string;
  createdAt: string;
};

export type PageRequest = { cursor?: string; limit?: number };
export type PageResult<T> = { items: T[]; nextCursor?: string };

export const MAX_BULK_RESOURCE_NAMES = 500;

export type ResourceWriteInput = {
  protoSchema: string;
  protoJson: string;
  archivedAt?: string;
  now?: string;
};

export type CurrentResourceWriteInput = ResourceWriteInput & {
  candidateVersionSequence?: number;
  candidateVersionLabel?: string;
  candidateSourceVersionId?: string;
  reviewedManifestDigest?: string;
};

export type RevisionWriteInput = {
  protoSchema: string;
  revisionProtoJson: string;
  versionSequence: number;
  revisionOrigin?: RevisionOrigin;
  lifecycle?: 'DRAFT' | 'CONFIRMED';
  exportEligible?: boolean;
  confirmationCommandId?: string;
  confirmedFromEtag?: string;
  frozenDependenciesProtoJson?: string;
  now?: string;
};

export type ExportBundleWriteInput = {
  protoSchema: string;
  bundleProtoJson: string;
  rootRevisionName: string;
  rootKind: 'TASK_SOP' | 'REQUIREMENT';
  schemaVersion: string;
  rendererVersion: string;
  contentSizeBytes: number;
  contentSha256: string;
  now?: string;
};

export type AtomicConfirmationInput = {
  commandId: string;
  rootName: string;
  expectedEtag: string;
  reviewedManifestDigest: string;
  confirmedRoot: CurrentResourceWriteInput;
  revision: RevisionWriteInput;
  bundle: ExportBundleWriteInput;
};

export type AtomicConfirmationResult = {
  root: CurrentResourceRecord;
  revision: RevisionRecord;
  bundle: ExportBundleRecord;
  idempotent: boolean;
};

export type AtomicRobotModelSaveInput = {
  rootName: string;
  expectedEtag: string;
  current: CurrentResourceWriteInput;
  revision: RevisionWriteInput;
};

export type AtomicRobotModelCreateInput = {
  current: CurrentResourceWriteInput;
  revision: RevisionWriteInput;
};

export type AtomicRobotModelSaveResult = {
  root: CurrentResourceRecord;
  revision: RevisionRecord;
  idempotent: boolean;
};

export type MetaRecord = {
  key: string;
  value: string;
  updatedAt: string;
};

/**
 * expectedValue omitted means "create only when absent". A supplied value
 * means "replace only when the stored value still equals this value".
 */
export type MetaCompareAndSetInput = {
  key: string;
  expectedValue?: string;
  nextValue: string;
  now?: string;
};

export class ResourceRepositoryError extends Error {}

export class ResourceNotFoundError extends ResourceRepositoryError {
  readonly code = 'NOT_FOUND' as const;
  constructor(readonly resourceName: string) {
    super(`Resource not found: ${resourceName}`);
    this.name = 'ResourceNotFoundError';
  }
}

export class ResourceConflictError extends ResourceRepositoryError {
  readonly code = 'STALE_ETAG' as const;
  constructor(readonly resourceName: string, readonly expectedEtag: string, readonly actualEtag?: string) {
    super(`Stale etag for ${resourceName}: expected ${expectedEtag}${actualEtag ? `, actual ${actualEtag}` : ''}`);
    this.name = 'ResourceConflictError';
  }
}

export class ProjectionMismatchError extends ResourceRepositoryError {
  readonly code = 'PROJECTION_MISMATCH' as const;
  constructor(readonly resourceName: string, readonly fields: string[]) {
    super(`Stored projection disagrees with ProtoJSON for ${resourceName}: ${fields.join(', ')}`);
    this.name = 'ProjectionMismatchError';
  }
}

export class InvalidCursorError extends ResourceRepositoryError {
  readonly code = 'INVALID_CURSOR' as const;
  constructor() {
    super('Invalid resource list cursor');
    this.name = 'InvalidCursorError';
  }
}

export class RepositoryNotReadyError extends ResourceRepositoryError {
  readonly code = 'NOT_READY' as const;
  constructor(readonly key: string, readonly expectedValue: string, readonly actualValue?: string) {
    super(`Repository is not ready: ${key} must equal ${expectedValue}${actualValue === undefined ? '' : `, actual ${actualValue}`}`);
    this.name = 'RepositoryNotReadyError';
  }
}

export interface ResourceRepository {
  getCatalog(name: string): Promise<CatalogResourceRecord | undefined>;
  getCatalogs(names: readonly string[]): Promise<CatalogResourceRecord[]>;
  listCatalog(kind: CatalogResourceKind, page?: PageRequest): Promise<PageResult<ResourceSummary>>;
  createCatalog(input: ResourceWriteInput): Promise<CatalogResourceRecord>;
  updateCatalog(name: string, expectedEtag: string, input: ResourceWriteInput): Promise<CatalogResourceRecord>;
  archiveCatalog(name: string, expectedEtag: string, input: ResourceWriteInput): Promise<CatalogResourceRecord>;

  getCurrent(name: string): Promise<CurrentResourceRecord | undefined>;
  listCurrent(kind: CurrentResourceKind, page?: PageRequest): Promise<PageResult<ResourceSummary>>;
  createCurrent(input: CurrentResourceWriteInput): Promise<CurrentResourceRecord>;
  updateCurrent(name: string, expectedEtag: string, input: CurrentResourceWriteInput): Promise<CurrentResourceRecord>;
  archiveCurrent(name: string, expectedEtag: string, input: CurrentResourceWriteInput): Promise<CurrentResourceRecord>;

  getRevision(name: string): Promise<RevisionRecord | undefined>;
  getRevisions(names: readonly string[]): Promise<RevisionRecord[]>;
  listRevisions(ownerName: string, page?: PageRequest): Promise<PageResult<RevisionSummary>>;
  createRevision(input: RevisionWriteInput): Promise<RevisionRecord>;
  getExportBundle(rootRevisionName: string): Promise<ExportBundleRecord | undefined>;
  createExportBundle(input: ExportBundleWriteInput): Promise<ExportBundleRecord>;

  loadReviewedDependencies(rootName: string): Promise<ReviewedDependency[]>;
  replaceReviewedDependencies(
    rootName: string,
    expectedEtag: string,
    manifestDigest: string,
    dependencies: ReviewedDependency[],
  ): Promise<CurrentResourceRecord>;
  createRobotModel(input: AtomicRobotModelCreateInput): Promise<AtomicRobotModelSaveResult>;
  saveRobotModel(input: AtomicRobotModelSaveInput): Promise<AtomicRobotModelSaveResult>;
  confirm(input: AtomicConfirmationInput): Promise<AtomicConfirmationResult>;

  getMeta(key: string): Promise<MetaRecord | undefined>;
  compareAndSetMeta(input: MetaCompareAndSetInput): Promise<boolean>;
  assertMeta(key: string, expectedValue: string): Promise<MetaRecord>;
  auditProjectionParity(): Promise<void>;
}
