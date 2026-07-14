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
  displayName: string;
  etag: string;
  lifecycle?: string;
  currentRevision?: string;
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
};
