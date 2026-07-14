import type { JsonValue } from '@bufbuild/protobuf';
import {
  AttachmentSchema,
  CustomerSchema,
  GlobalFieldSchema,
  MaterialSchema,
  MaterialStateRuleSchema,
  RobotModelRevisionSchema,
  RobotModelSchema,
  SceneSchema,
  type Attachment,
  type Customer,
  type GlobalField,
  type Material,
  type MaterialStateRule,
  type RobotModel,
  type RobotModelRevision,
  type Scene,
} from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import {
  RequirementRevisionSchema,
  RequirementSchema,
  type Requirement,
  type RequirementRevision,
} from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import {
  TaskSopRevisionSchema,
  TaskSopSchema,
  type TaskSop,
  type TaskSopRevision,
} from '../../gen/coscene/sop/v1alpha1/task_sop_pb';
import { fromDomainJson, toDomainJson } from '../../shared/domain/codec';
import { assertValidDomainMessage } from '../../shared/domain/validation';
import { CanonicalDataError } from './errors';

export const canonicalSchemaVersion = 'coscene.sop.v1alpha1' as const;
export const attachmentOperationsSchemaVersion = 'coscene.sop.attachment-operations/v1' as const;

export type AttachmentUploadScope = 'material' | 'requirement' | 'task_sop';
export type AttachmentUploadState = {
  uploadId: string;
  storageKey: string;
  attachmentName: string;
  attachmentId: string;
  filename: string;
  mediaType: string;
  expectedSizeBytes: number;
  publicUri?: string;
  sha256?: string;
  scope: AttachmentUploadScope;
  ownerId: string;
  version: string;
  parts: Array<{ partNumber: number; etag: string; sizeBytes: number }>;
  createdAt: string;
  expiresAt: string;
};
export type AttachmentCleanupIntent = {
  id: string;
  storageKey: string;
  state: 'PENDING' | 'CLAIMED';
  operation: 'DELETE_OBJECT' | 'ABORT_MULTIPART';
  uploadId?: string;
  claimId?: string;
  claimedAt?: string;
  notBefore: string;
  attempts: number;
  lastError?: string;
};
export type AttachmentLease = { storageKey: string; generationId: string; expiresAt?: string };
export type AttachmentOperationalState = {
  schemaVersion: typeof attachmentOperationsSchemaVersion;
  uploads: AttachmentUploadState[];
  cleanupIntents: AttachmentCleanupIntent[];
  leases: AttachmentLease[];
};

export type CanonicalSnapshot = {
  schemaVersion: typeof canonicalSchemaVersion;
  customers: Customer[];
  materials: Material[];
  robotModels: RobotModel[];
  robotModelRevisions: RobotModelRevision[];
  scenes: Scene[];
  globalFields: GlobalField[];
  materialStateRules: MaterialStateRule[];
  attachments: Attachment[];
  taskSops: TaskSop[];
  taskSopRevisions: TaskSopRevision[];
  requirements: Requirement[];
  requirementRevisions: RequirementRevision[];
  operational: AttachmentOperationalState;
};

export type StorePin = {
  namespace: string;
  epoch: number;
  generation: number;
  writable: boolean;
};

export type SnapshotMutation = (snapshot: CanonicalSnapshot) => CanonicalSnapshot | Promise<CanonicalSnapshot>;

/** Canonical metadata repository. Object bytes are deliberately not part of this contract. */
export interface AppStore {
  pin(namespace?: string): Promise<StorePin>;
  readSnapshot(pin: StorePin): Promise<CanonicalSnapshot>;
  commit(pin: StorePin, mutation: SnapshotMutation): Promise<{ pin: StorePin; snapshot: CanonicalSnapshot }>;
  setWriteState(pin: StorePin, writable: boolean): Promise<StorePin>;
}

export function emptyCanonicalSnapshot(): CanonicalSnapshot {
  return {
    schemaVersion: canonicalSchemaVersion,
    customers: [],
    materials: [],
    robotModels: [],
    robotModelRevisions: [],
    scenes: [],
    globalFields: [],
    materialStateRules: [],
    attachments: [],
    taskSops: [],
    taskSopRevisions: [],
    requirements: [],
    requirementRevisions: [],
    operational: emptyAttachmentOperationalState(),
  };
}

export function emptyAttachmentOperationalState(): AttachmentOperationalState {
  return { schemaVersion: attachmentOperationsSchemaVersion, uploads: [], cleanupIntents: [], leases: [] };
}

type PersistedCanonicalSnapshot = {
  schemaVersion: string;
  resources: Record<string, JsonValue[]>;
  operational?: AttachmentOperationalState;
};

const collections = {
  customers: CustomerSchema,
  materials: MaterialSchema,
  robotModels: RobotModelSchema,
  robotModelRevisions: RobotModelRevisionSchema,
  scenes: SceneSchema,
  globalFields: GlobalFieldSchema,
  materialStateRules: MaterialStateRuleSchema,
  attachments: AttachmentSchema,
  taskSops: TaskSopSchema,
  taskSopRevisions: TaskSopRevisionSchema,
  requirements: RequirementSchema,
  requirementRevisions: RequirementRevisionSchema,
} as const;

export function encodeCanonicalSnapshot(snapshot: CanonicalSnapshot): string {
  if (snapshot.schemaVersion !== canonicalSchemaVersion) {
    throw new CanonicalDataError(`Unsupported canonical schema version: ${snapshot.schemaVersion}`);
  }
  const resources: Record<string, JsonValue[]> = {};
  for (const [key, schema] of Object.entries(collections)) {
    resources[key] = (snapshot[key as keyof typeof collections] as never[]).map((message) => {
      assertValidDomainMessage(schema, message);
      return toDomainJson(schema, message);
    });
  }
  if (snapshot.operational.schemaVersion !== attachmentOperationsSchemaVersion) {
    throw new CanonicalDataError(`Unsupported attachment operations schema version: ${snapshot.operational.schemaVersion}`);
  }
  const hasOperationalState = snapshot.operational.uploads.length > 0 || snapshot.operational.cleanupIntents.length > 0 || snapshot.operational.leases.length > 0;
  return JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    resources,
    ...(hasOperationalState ? { operational: snapshot.operational } : {}),
  } satisfies PersistedCanonicalSnapshot);
}

function decodeOperational(value: unknown): AttachmentOperationalState {
  if (value === undefined) return emptyAttachmentOperationalState();
  if (!value || typeof value !== 'object') throw new TypeError('invalid attachment operational envelope');
  const state = value as Partial<AttachmentOperationalState>;
  if (state.schemaVersion !== attachmentOperationsSchemaVersion || !Array.isArray(state.uploads) ||
    !Array.isArray(state.cleanupIntents) || !Array.isArray(state.leases)) {
    throw new TypeError('invalid attachment operational envelope');
  }
  const text = (candidate: unknown) => typeof candidate === 'string' && candidate.length > 0;
  const iso = (candidate: unknown) => text(candidate) && !Number.isNaN(new Date(candidate as string).getTime());
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new TypeError(`duplicate ${label}`);
  };
  for (const upload of state.uploads) {
    if (!text(upload.uploadId) || !text(upload.storageKey) || !text(upload.attachmentName) || !text(upload.attachmentId) ||
      !text(upload.filename) || !text(upload.mediaType) || !Number.isSafeInteger(upload.expectedSizeBytes) || upload.expectedSizeBytes <= 0 ||
      (upload.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(upload.sha256)) ||
      !['material', 'requirement', 'task_sop'].includes(upload.scope) || !text(upload.ownerId) ||
      !text(upload.version) || !Array.isArray(upload.parts) || !iso(upload.createdAt) || !iso(upload.expiresAt)) throw new TypeError('invalid attachment upload state');
    for (const part of upload.parts) {
      if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || !text(part.etag) || !Number.isSafeInteger(part.sizeBytes) || part.sizeBytes <= 0) {
        throw new TypeError('invalid attachment upload part state');
      }
    }
    unique(upload.parts.map((part) => String(part.partNumber)), 'attachment upload part');
  }
  for (const intent of state.cleanupIntents) {
    if (!text(intent.id) || !text(intent.storageKey) || !['PENDING', 'CLAIMED'].includes(intent.state) ||
      !['DELETE_OBJECT', 'ABORT_MULTIPART'].includes(intent.operation) || !iso(intent.notBefore) ||
      (intent.operation === 'ABORT_MULTIPART' && !text(intent.uploadId)) ||
      (intent.state === 'CLAIMED' && (!text(intent.claimId) || !iso(intent.claimedAt))) ||
      !Number.isInteger(intent.attempts) || intent.attempts < 0) throw new TypeError('invalid attachment cleanup intent');
  }
  for (const lease of state.leases) {
    if (!text(lease.storageKey) || !text(lease.generationId) || (lease.expiresAt !== undefined && !iso(lease.expiresAt))) {
      throw new TypeError('invalid attachment lease');
    }
  }
  unique(state.uploads.map((upload) => upload.uploadId), 'attachment upload id');
  unique(state.cleanupIntents.map((intent) => intent.id), 'attachment cleanup intent id');
  unique(state.leases.map((lease) => `${lease.generationId}:${lease.storageKey}`), 'attachment lease');
  return structuredClone(state as AttachmentOperationalState);
}

export function decodeCanonicalSnapshot(value: string): CanonicalSnapshot {
  try {
    const envelope = JSON.parse(value) as Partial<PersistedCanonicalSnapshot>;
    if (!envelope || envelope.schemaVersion !== canonicalSchemaVersion || !envelope.resources || typeof envelope.resources !== 'object') {
      throw new TypeError('invalid canonical snapshot envelope');
    }
    const snapshot = emptyCanonicalSnapshot();
    for (const [key, schema] of Object.entries(collections)) {
      const records = envelope.resources[key];
      if (!Array.isArray(records)) throw new TypeError(`missing resource collection ${key}`);
      const decoded = records.map((record) => {
        const message = fromDomainJson(schema, record);
        assertValidDomainMessage(schema, message);
        return message;
      });
      (snapshot as unknown as Record<string, unknown>)[key] = decoded;
    }
    snapshot.operational = decodeOperational(envelope.operational);
    return snapshot;
  } catch (error) {
    if (error instanceof CanonicalDataError) throw error;
    throw new CanonicalDataError('Malformed canonical snapshot', { cause: error });
  }
}

export function cloneCanonicalSnapshot(snapshot: CanonicalSnapshot): CanonicalSnapshot {
  return decodeCanonicalSnapshot(encodeCanonicalSnapshot(snapshot));
}
