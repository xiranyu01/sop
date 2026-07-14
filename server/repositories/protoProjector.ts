import type {
  CatalogResourceKind,
  CurrentLifecycle,
  CurrentResourceKind,
  RevisionKind,
  RevisionOrigin,
} from '../domain/repository';

type JsonObject = Record<string, unknown>;

export type ProjectedResourceColumns = {
  name: string;
  uid: string;
  kind: CatalogResourceKind | CurrentResourceKind;
  sourceId?: string;
  displayName: string;
  etag: string;
  lifecycle?: CurrentLifecycle;
  candidateVersionSequence?: number;
  candidateVersionLabel?: string;
  candidateSourceVersionId?: string;
  currentRevisionName?: string;
  reviewedManifestDigest?: string;
};

export type ProjectedRevisionColumns = {
  name: string;
  uid: string;
  ownerName: string;
  kind: RevisionKind;
  versionLabel: string;
  previousRevisionName?: string;
  revisionOrigin: RevisionOrigin;
  lifecycle: 'DRAFT' | 'CONFIRMED';
  exportEligible: boolean;
};

export type ProjectedBundleColumns = {
  rootRevisionName: string;
  rootKind: 'TASK_SOP' | 'REQUIREMENT';
  schemaVersion: string;
  rendererVersion: string;
  contentSizeBytes: number;
  contentSha256: string;
};

const schemaKinds: Readonly<Record<string, CatalogResourceKind | CurrentResourceKind | RevisionKind>> = {
  Customer: 'CUSTOMER',
  Material: 'MATERIAL',
  Scene: 'SCENE',
  GlobalField: 'GLOBAL_FIELD',
  MaterialStateRule: 'MATERIAL_STATE_RULE',
  Attachment: 'ATTACHMENT',
  RobotModel: 'ROBOT_MODEL',
  TaskSop: 'TASK_SOP',
  Requirement: 'REQUIREMENT',
  RobotModelRevision: 'ROBOT_MODEL_REVISION',
  TaskSopRevision: 'TASK_SOP_REVISION',
  RequirementRevision: 'REQUIREMENT_REVISION',
};

function parseObject(protoJson: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(protoJson);
  } catch (cause) {
    throw new TypeError(`${label} ProtoJSON is invalid`, { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${label} ProtoJSON must be an object`);
  }
  return parsed as JsonObject;
}

function field(object: JsonObject, camelCase: string, snakeCase = camelCase): unknown {
  return object[camelCase] ?? object[snakeCase];
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${fieldName} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, fieldName);
}

function schemaLeaf(protoSchema: string): string {
  const leaf = protoSchema.split(/[./]/).at(-1);
  return requiredString(leaf, 'protoSchema');
}

function schemaKind(protoSchema: string): CatalogResourceKind | CurrentResourceKind | RevisionKind {
  const kind = schemaKinds[schemaLeaf(protoSchema)];
  if (!kind) throw new TypeError(`Unsupported Proto schema: ${protoSchema}`);
  return kind;
}

function isRevisionKind(kind: CatalogResourceKind | CurrentResourceKind | RevisionKind): kind is RevisionKind {
  return kind === 'ROBOT_MODEL_REVISION' || kind === 'TASK_SOP_REVISION' || kind === 'REQUIREMENT_REVISION';
}

function isCurrentKind(kind: CatalogResourceKind | CurrentResourceKind | RevisionKind): kind is CurrentResourceKind {
  return kind === 'ROBOT_MODEL' || kind === 'TASK_SOP' || kind === 'REQUIREMENT';
}

function lifecycle(value: unknown, currentKind: CurrentResourceKind): CurrentLifecycle {
  if (currentKind === 'ROBOT_MODEL' && (value === undefined || value === null || value === '')) return 'ACTIVE';
  if (typeof value === 'number') {
    if (value === 1) return 'DRAFT';
    if (value === 2) return 'CONFIRMED';
    if (value === 3) return 'ARCHIVED';
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/^LIFECYCLE_/, '');
    if (normalized === 'DRAFT' || normalized === 'CONFIRMED' || normalized === 'ARCHIVED') return normalized;
    if (normalized === 'ACTIVE' && currentKind === 'ROBOT_MODEL') return normalized;
  }
  throw new TypeError(`Unsupported lifecycle for ${currentKind}: ${String(value)}`);
}

function revisionOrigin(value: unknown): RevisionOrigin {
  if (typeof value === 'number') {
    if (value === 1) return 'RUNTIME_CONFIRMED';
    if (value === 2) return 'IMPORTED_CONFIRMED';
    if (value === 3) return 'IMPORTED_DRAFT_CHECKPOINT';
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/^REVISION_ORIGIN_/, '');
    if (normalized === 'RUNTIME_CONFIRMED' || normalized === 'IMPORTED_CONFIRMED' || normalized === 'IMPORTED_DRAFT_CHECKPOINT') {
      return normalized;
    }
  }
  throw new TypeError(`Unsupported revision origin: ${String(value)}`);
}

function boolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${fieldName} must be a boolean`);
  return value;
}

function integer(value: unknown, fieldName: string): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) throw new TypeError(`${fieldName} must be a safe integer`);
  return parsed;
}


function optionalInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return integer(value, fieldName);
}

export function withResourceEtag(protoJson: string, etag: string): string {
  const message = parseObject(protoJson, 'resource');
  message.etag = requiredString(etag, 'etag');
  return JSON.stringify(message);
}

export function withReviewedDependencyDigest(protoJson: string, etag: string, digest: string): string {
  const message = parseObject(protoJson, 'resource');
  message.etag = requiredString(etag, 'etag');
  message.reviewedDependencyDigest = requiredString(digest, 'reviewedDependencyDigest');
  delete message.reviewed_dependency_digest;
  return JSON.stringify(message);
}

export function projectResource(protoSchema: string, protoJson: string): ProjectedResourceColumns {
  const message = parseObject(protoJson, 'resource');
  const kind = schemaKind(protoSchema);
  if (isRevisionKind(kind)) throw new TypeError(`${protoSchema} is a revision schema`);
  const currentKind = isCurrentKind(kind) ? kind : undefined;
  return {
    name: requiredString(field(message, 'name'), 'name'),
    uid: requiredString(field(message, 'uid'), 'uid'),
    kind,
    sourceId: optionalString(field(message, 'sourceId', 'source_id'), 'sourceId'),
    displayName: requiredString(
      field(message, 'displayName', 'display_name')
        ?? field(message, 'label')
        ?? field(message, 'filename')
        ?? field(message, 'materialType', 'material_type')
        ?? field(message, 'name'),
      'displayName',
    ),
    etag: requiredString(field(message, 'etag'), 'etag'),
    ...(currentKind ? {
      lifecycle: lifecycle(field(message, 'lifecycle'), currentKind),
      candidateVersionSequence: optionalInteger(
        field(message, 'candidateVersionSequence', 'candidate_version_sequence'),
        'candidateVersionSequence',
      ),
      candidateVersionLabel: optionalString(
        field(message, 'candidateVersionLabel', 'candidate_version_label'),
        'candidateVersionLabel',
      ),
      candidateSourceVersionId: optionalString(
        field(message, 'candidateSourceVersionId', 'candidate_source_version_id'),
        'candidateSourceVersionId',
      ),
      currentRevisionName: optionalString(field(message, 'currentRevision', 'current_revision'), 'currentRevision'),
      reviewedManifestDigest: optionalString(
        field(message, 'reviewedDependencyDigest', 'reviewed_dependency_digest'),
        'reviewedDependencyDigest',
      ),
    } : {}),
  };
}

export function projectRevision(
  protoSchema: string,
  protoJson: string,
  physical: Partial<Pick<ProjectedRevisionColumns, 'revisionOrigin' | 'lifecycle' | 'exportEligible'>> = {},
): ProjectedRevisionColumns {
  const revision = parseObject(protoJson, 'revision');
  const kind = schemaKind(protoSchema);
  if (!isRevisionKind(kind)) throw new TypeError(`${protoSchema} is not a revision schema`);
  const snapshot = field(revision, 'snapshot');
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('revision.snapshot must be an object');
  const owner = snapshot as JsonObject;
  const originValue = field(revision, 'origin');
  const origin = originValue === undefined && kind === 'ROBOT_MODEL_REVISION'
    ? physical.revisionOrigin ?? 'RUNTIME_CONFIRMED'
    : revisionOrigin(originValue);
  const ownerKind = kind === 'ROBOT_MODEL_REVISION' ? 'ROBOT_MODEL' : kind === 'TASK_SOP_REVISION' ? 'TASK_SOP' : 'REQUIREMENT';
  const projectedLifecycle = kind === 'ROBOT_MODEL_REVISION'
    ? physical.lifecycle ?? 'CONFIRMED'
    : lifecycle(field(owner, 'lifecycle'), ownerKind) === 'DRAFT' ? 'DRAFT' : 'CONFIRMED';
  const rawExportEligible = field(revision, 'exportEligible', 'export_eligible');
  // proto3 JSON omits scalar false. Prefer the Proto value when present, and
  // use the physical column only to recover an omitted explicit false.
  const projectedExportEligible = rawExportEligible === undefined
    ? physical.exportEligible ?? false
    : boolean(rawExportEligible, 'revision.exportEligible');
  return {
    name: requiredString(field(revision, 'name'), 'revision.name'),
    uid: requiredString(field(revision, 'uid'), 'revision.uid'),
    ownerName: requiredString(field(owner, 'name'), 'revision.snapshot.name'),
    kind,
    versionLabel: requiredString(field(revision, 'versionLabel', 'version_label'), 'revision.versionLabel'),
    previousRevisionName: optionalString(field(revision, 'previousRevision', 'previous_revision'), 'revision.previousRevision'),
    revisionOrigin: origin,
    lifecycle: projectedLifecycle,
    exportEligible: projectedExportEligible,
  };
}

export function projectBundle(protoJson: string): ProjectedBundleColumns {
  const bundle = parseObject(protoJson, 'bundle');
  const contentValue = field(bundle, 'content');
  if (!contentValue || typeof contentValue !== 'object' || Array.isArray(contentValue)) throw new TypeError('bundle.content must be an object');
  const content = contentValue as JsonObject;
  const rootValue = field(content, 'root');
  if (!rootValue || typeof rootValue !== 'object' || Array.isArray(rootValue)) throw new TypeError('bundle.content.root must be an object');
  const root = rootValue as JsonObject;
  const rawRootKind = field(root, 'kind');
  const rootKind = rawRootKind === 1 || rawRootKind === 'ROOT_KIND_REQUIREMENT' || rawRootKind === 'REQUIREMENT'
    ? 'REQUIREMENT'
    : rawRootKind === 2 || rawRootKind === 'ROOT_KIND_TASK_SOP' || rawRootKind === 'TASK_SOP'
      ? 'TASK_SOP'
      : undefined;
  if (!rootKind) throw new TypeError(`Unsupported bundle root kind: ${String(rawRootKind)}`);
  return {
    rootRevisionName: requiredString(field(content, 'revisionName', 'revision_name'), 'bundle.content.revisionName'),
    rootKind,
    schemaVersion: requiredString(field(bundle, 'schemaVersion', 'schema_version'), 'bundle.schemaVersion'),
    rendererVersion: requiredString(field(content, 'rendererVersion', 'renderer_version'), 'bundle.content.rendererVersion'),
    contentSizeBytes: integer(field(bundle, 'contentSizeBytes', 'content_size_bytes'), 'bundle.contentSizeBytes'),
    contentSha256: requiredString(field(bundle, 'contentSha256', 'content_sha256'), 'bundle.contentSha256'),
  };
}

export function projectionDifferences(
  stored: Readonly<Record<string, unknown>>,
  projected: Readonly<Record<string, unknown>>,
): string[] {
  const differences: string[] = [];
  for (const [key, projectedValue] of Object.entries(projected)) {
    const storedValue = stored[key];
    const normalizedStored = storedValue === null ? undefined : storedValue;
    if (normalizedStored !== projectedValue) differences.push(key);
  }
  return differences;
}
