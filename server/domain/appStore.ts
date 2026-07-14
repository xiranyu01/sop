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
  };
}

type PersistedCanonicalSnapshot = { schemaVersion: string; resources: Record<string, JsonValue[]> };

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
  return JSON.stringify({ schemaVersion: snapshot.schemaVersion, resources } satisfies PersistedCanonicalSnapshot);
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
    return snapshot;
  } catch (error) {
    if (error instanceof CanonicalDataError) throw error;
    throw new CanonicalDataError('Malformed canonical snapshot', { cause: error });
  }
}

export function cloneCanonicalSnapshot(snapshot: CanonicalSnapshot): CanonicalSnapshot {
  return decodeCanonicalSnapshot(encodeCanonicalSnapshot(snapshot));
}

