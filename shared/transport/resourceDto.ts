import type { JsonValue } from '@bufbuild/protobuf';

export type SaveWarning = {
  kind: 'row_size';
  resourceName: string;
  measuredBytes: number;
  limitBytes: number;
};

export type ResourceKind =
  | 'customers'
  | 'materials'
  | 'robotModels'
  | 'scenes'
  | 'globalFields'
  | 'materialStateRules'
  | 'attachments'
  | 'taskSops'
  | 'requirements';

export type ResourceSummary = {
  kind: ResourceKind;
  name: string;
  uid: string;
  sourceId?: string;
  displayName: string;
  etag: string;
  lifecycle?: string;
  currentRevision?: string;
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
  createdAt?: string;
  /** List-visible fields for compact catalog resources such as customers, materials, and global fields. */
  listView?: JsonValue;
  archived: boolean;
};

export type ResourceDetail = ResourceSummary & { resource: JsonValue };

export type ResourcePage = {
  items: ResourceSummary[];
  nextCursor?: string;
};

export type ResourceMutationResult = {
  resource: ResourceDetail;
  warning?: SaveWarning;
};

export type RevisionSummary = {
  name: string;
  uid: string;
  versionLabel: string;
  origin: string;
  lifecycle: string;
  exportEligible: boolean;
  sourceVersionId?: string;
  createdAt?: string;
};

export type RevisionDetail = RevisionSummary & {
  ownerName: string;
  kind: 'ROBOT_MODEL_REVISION' | 'TASK_SOP_REVISION' | 'REQUIREMENT_REVISION';
  previousRevisionName?: string;
  resource: JsonValue;
};

export type VersionRouteTarget = {
  kind: 'requirements' | 'taskSops';
  ownerName: string;
  versionLabel: string;
  versionUid: string;
  draft: boolean;
};

export type DependencyChange = {
  kind: number;
  resourceName: string;
  beforeToken?: string;
  afterToken?: string;
};

export type DependencyReviewResult = {
  proposalDigest: string;
  rootName: string;
  rootEtag: string;
  dependencies: Array<{ kind: number; resourceName: string; token: string }>;
  added: DependencyChange[];
  removed: DependencyChange[];
  changed: DependencyChange[];
  empty: boolean;
};

export type ConfirmationResult = {
  resource: ResourceDetail;
  revision: RevisionDetail;
  idempotent: boolean;
  exportPath: string;
  warning?: SaveWarning;
};
