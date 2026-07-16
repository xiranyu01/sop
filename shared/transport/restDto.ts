/**
 * REST compatibility DTOs consumed by the browser forms.
 *
 * These types are deliberately not the domain contract. The authoritative
 * model is generated from proto/coscene/sop/v1alpha1; this projection exists
 * only at the HTTP/UI anti-corruption boundary while the REST API is retained.
 */
export type EntityStatus = 'draft' | 'confirmed' | 'archived';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type QuantityMode = 'fixed' | 'range';
export type ChangeFrequency = 'every_record' | 'every_n_records' | 'per_batch' | 'fixed';
export type GlobalFieldStatus = 'active' | 'inactive';
export type GlobalFieldGroup =
  | 'robot_state'
  | 'reference_object'
  | 'relative_position'
  | 'support_surface'
  | 'region'
  | 'pose'
  | 'form'
  | 'parameter'
  | 'allowed_operation'
  | 'acceptable_operation'
  | 'forbidden_operation'
  | 'annotation_allowed_operation'
  | 'annotation_forbidden_operation'
  | 'random_field'
  | 'robot_random_field'
  | 'material_random_field'
  | 'annotation_type'
  | 'delivery_format'
  | 'delivery_language'
  | 'delivery_method'
  | 'sampling_policy';

export interface Contact {
  name: string;
  phone: string;
  email: string;
}

export interface Customer {
  id: string;
  name: string;
  contact: Contact;
  notes?: string;
}

export interface Material {
  id: string;
  skuId: string;
  type: string;
  color: string;
  material: string;
  packageType: string;
  size?: string;
  weight?: string;
  images?: RequirementAttachment[];
}

export interface RobotModel {
  id: string;
  brand: string;
  model: string;
  terminal: string;
  topics: Record<string, string>;
  extraTopicRequirements: Record<string, string>;
}

export interface GlobalField {
  id: string;
  group: GlobalFieldGroup;
  label: string;
  value: string;
  category?: string;
  description?: string;
  status: GlobalFieldStatus;
  updatedAt: string;
}

export interface MaterialStateRule {
  id: string;
  materialType: string;
  primaryReferences: string[];
  primaryRelativePositions: string[];
  supportSurfaces: string[];
  regions: string[];
  secondaryReferences: string[];
  secondaryRelativePositions: string[];
  poses: string[];
  forms: string[];
  parameters: string[];
  updatedAt: string;
}

export interface Quantity {
  mode: QuantityMode;
  value?: number;
  min?: number;
  max?: number;
  unit: string;
}

export interface ScenarioMaterial {
  materialId: string;
  skuId: string;
  type: string;
  quantity: Quantity;
  color: string;
  material: string;
  packageType: string;
}

export interface TextItem {
  type?: string;
  description: string;
}

export interface OperationStep {
  order: number;
  description: string;
  atomicSkill?: string;
  englishDescription?: string;
  englishAtomicSkill?: string;
}

export interface ReferenceStep {
  level: number;
  referenceObject: string;
  relativePosition: string;
}

export interface AllowedLocation {
  location: string;
  referencePath: ReferenceStep[];
  supportSurface: string;
  allowedRegions: string[];
  allowedPose: string[];
  allowedForm: string[];
  parameters?: string[];
  collectorInstruction?: string;
  exampleImageAttachmentIds?: string[];
  constraints: string[];
}

export interface ObjectInitialState {
  object: string;
  allowedLocations: AllowedLocation[];
}

export interface ObjectTargetState {
  object: string;
  requiredLocation: string;
  requiredRegions: string[];
  requiredPose: string[];
  requiredForm: string[];
  referencePath?: ReferenceStep[];
  supportSurface?: string;
  parameters?: string[];
  collectorInstruction?: string;
  exampleImageAttachmentIds?: string[];
  constraints?: string[];
}

export interface DuringOperationParameter {
  name: string;
  displayName: string;
  valueType: string;
  unit?: string;
  allowedValues?: string[];
  sampling?: {
    mode: 'fixed' | 'range';
    value?: number;
    min?: number;
    max?: number;
  };
  constraints: string[];
}

export interface DuringOperationObjectState {
  object: string;
  parameters: DuringOperationParameter[];
}

export interface RandomizedField {
  field: string;
  displayName: string;
  constraints: string[];
}

export interface Randomization {
  robotInitialState: {
    enabled: boolean;
    changeFrequency: ChangeFrequency;
    changeIntervalRecords?: number;
    randomizedFields: RandomizedField[];
  };
  materialInitialState: {
    rules: Array<{
      targetMaterials: string[];
      changeFrequency: ChangeFrequency;
      changeIntervalRecords?: number;
      randomizedFields: {
        locations: Array<{ name: string; valueSource: string }>;
        poses: Array<{ name: string; valueSource: string }>;
        forms: Array<{ name: string; valueSource: string }>;
      };
      collectorInstruction?: string;
      exampleImageAttachmentIds?: string[];
      constraints: string[];
    }>;
  };
  materialStateDuringOperation?: {
    rules: Array<{
      targetMaterial: string;
      changeFrequency: ChangeFrequency;
      changeIntervalRecords?: number;
      randomizedFields: { parameters: Array<{ name: string }> };
    }>;
  };
}

export interface SubsceneVersion {
  version: string;
  versionId?: string;
  parentVersionId?: string;
  createdAt?: string;
  status: EntityStatus;
  title: string;
  sceneName?: string;
  subsceneName?: string;
  description: string;
  attachments?: RequirementAttachment[];
  requiredDurationHours?: number;
  materials: ScenarioMaterial[];
  robotState: {
    initial: string;
    target: string;
  };
  robotOperationRequirements?: string;
  robotInitialRandomizationRequirements?: string[];
  randomizationFrequency?: string;
  randomization: Randomization;
  operation: {
    stepOrder: string;
    steps: OperationStep[];
    stepRandomization?: {
      enabled: boolean;
      startOrder: number;
      endOrder: number;
    };
    allowedOperations: TextItem[];
    acceptableOperations?: TextItem[];
    forbiddenOperations: TextItem[];
  };
  objectStates: {
    initial: ObjectInitialState[];
    target: ObjectTargetState[];
    duringOperation?: DuringOperationObjectState[];
  };
  materialStateRules?: MaterialStateRule[];
  annotation: {
    status: 'pending' | 'ready' | 'not_required';
    note: string;
    actionTags: string[];
    steps?: OperationStep[];
    allowedOperations?: TextItem[];
    forbiddenOperations?: TextItem[];
    stepRandomization?: {
      enabled: boolean;
      startOrder: number;
      endOrder: number;
    };
  };
  references: {
    recordUrls: string[];
    attachments: Array<{ fileToken: string; name: string; size: number }>;
  };
  updatedAt: string;
}

export interface Subscene {
  code: string;
  name: string;
  versions: SubsceneVersion[];
}

export interface Scene {
  id: string;
  name: string;
  description: string;
  subscenes: Subscene[];
}

export interface TaskSopReference {
  sceneName: string;
  title: string;
  version: string;
  versionId?: string;
  parentVersionId?: string;
  status?: EntityStatus;
}

export interface RequestedSubscene {
  id?: string;
  title?: string;
  description?: string;
  subsceneCode?: string;
  subsceneName?: string;
  sceneName: string;
  version?: string;
  targetDurationHours: number;
  targetCollectionCount?: number;
  taskSop?: TaskSopReference;
}

export interface RequirementAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
  storageKey: string;
  uploadedAt: string;
}

export interface AttachmentUploadInit {
  attachmentId: string;
  uploadId: string;
  storageKey: string;
  partSize: number;
  maxSize: number;
}

export interface AttachmentUploadPart {
  partNumber: number;
  etag: string;
}

export interface RequirementVersion {
  version: string;
  versionId?: string;
  parentVersionId?: string;
  createdAt?: string;
  status: EntityStatus;
  title: string;
  projectName: string;
  priority: Priority;
  deadline: string;
  sourceBaseUrl?: string;
  attachmentNotes?: string;
  attachments?: RequirementAttachment[];
  extraTopicRequirementsText?: string;
  globalRandomizationRequirements?: string;
  additionalNotes?: string;
  customerId: string;
  robotModelId: string;
  businessGoal: string;
  requestedScenes: string[];
  requiredDurationHours: number;
  allowedOperations: Array<{ operation: string; note: string }>;
  acceptableOperations?: Array<{ operation: string; note: string }>;
  forbiddenOperations: Array<{ category: string; operations: Array<{ operation: string; note: string }> }>;
  annotation: {
    required: boolean;
    types: string[];
    allowedOperations?: Array<{ operation: string; note: string }>;
    forbiddenOperations?: Array<{ operation: string; note: string }>;
  };
  qualityInspection: {
    required: boolean;
    samplingPolicy: string;
  };
  delivery: {
    formats: string[];
    method: string;
    languages: Array<{ code: string; name: string }>;
    dataStructureUrl: string;
  };
  selectedSubscenes: RequestedSubscene[];
  updatedAt: string;
}

export interface Requirement {
  id: string;
  versions: RequirementVersion[];
}

export interface AppMetadata {
  appDataSchemaVersion: string;
  requirementYamlSchemaVersion: string;
  taskSopYamlSchemaVersion: string;
}

export interface AppData {
  metadata: AppMetadata;
  customers: Customer[];
  materials: Material[];
  robotModels: RobotModel[];
  scenes: Scene[];
  requirements: Requirement[];
  globalFields: GlobalField[];
  materialStateRules: MaterialStateRule[];
}

export interface ExportResult {
  yaml: string;
  path: string;
}

export type ApiRequest = {
  method: string;
  pathname: string;
  search?: string;
  body?: unknown;
  rawBody?: ArrayBuffer;
  authorization?: string | null;
  attachmentPublicBaseUrl?: string;
  auth?: { password?: string; requireConfigured?: boolean };
};

export type ApiResponse = { status: number; body: unknown; headers?: Record<string, string> };
