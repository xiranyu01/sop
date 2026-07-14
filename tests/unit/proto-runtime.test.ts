import { create, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import { createValidator } from '@bufbuild/protovalidate';
import { describe, expect, it } from 'vitest';
import {
  AttachmentSchema,
  CustomerSchema,
  FrozenDependencyContextSchema,
  GlobalFieldSchema,
  MaterialSchema,
  MaterialStateRuleSchema,
  RobotModelRevisionSchema,
  RobotModelSchema,
  SceneSchema,
} from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import {
  GlobalFieldGroup,
  GlobalFieldStatus,
  Lifecycle,
  OperationStepSchema,
  Priority,
  DependencyKind,
  DependencyReviewProposalSchema,
  RevisionOrigin,
} from '../../gen/coscene/sop/v1alpha1/common_pb';
import {
  RequirementRevisionSchema,
  RequirementSchema,
  RequirementSpecSchema,
} from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import {
  TaskSopRevisionSchema,
  TaskSopSchema,
  TaskSopSpecSchema,
} from '../../gen/coscene/sop/v1alpha1/task_sop_pb';

const customer = create(CustomerSchema, {
  name: 'customers/acme',
  uid: '00000000-0000-4000-8000-000000000001',
  displayName: 'Acme',
  primaryContact: { displayName: 'Ada', email: 'ada@example.com' },
});
const attachment = create(AttachmentSchema, {
  name: 'attachments/reference-1',
  uid: '00000000-0000-4000-8000-000000000002',
  filename: 'reference.png',
  mediaType: 'image/png',
  sizeBytes: 12n,
  uri: 'https://assets.example.com/reference.png',
  storageKey: 'attachments/reference.png',
});
const material = create(MaterialSchema, {
  name: 'materials/cup',
  uid: '00000000-0000-4000-8000-000000000003',
  displayName: 'Cup',
  sku: 'CUP-1',
  category: 'container',
  colors: ['blue'],
  compositions: ['ceramic'],
  packaging: 'box',
  size: '10cm',
  weight: '250g',
  images: [attachment.name],
});
const scene = create(SceneSchema, {
  name: 'scenes/kitchen',
  uid: '00000000-0000-4000-8000-000000000004',
  displayName: 'Kitchen',
});
const globalField = create(GlobalFieldSchema, {
  name: 'globalFields/delivery-language-zh',
  uid: '00000000-0000-4000-8000-000000000005',
  group: GlobalFieldGroup.DELIVERY_LANGUAGE,
  label: '中文',
  value: 'zh-CN:中文',
  status: GlobalFieldStatus.ACTIVE,
});
const materialStateRule = create(MaterialStateRuleSchema, {
  name: 'materialStateRules/container',
  uid: '00000000-0000-4000-8000-000000000006',
  materialType: 'container',
  primaryReferences: ['table'],
  primaryRelativePositions: ['on'],
  supportSurfaces: ['countertop'],
});
const robot = create(RobotModelSchema, {
  name: 'robotModels/arm',
  uid: '00000000-0000-4000-8000-000000000007',
  displayName: 'Arm',
  manufacturer: 'Cos',
  modelCode: 'A1',
  endEffector: 'gripper',
  topics: [{ id: 'camera', topic: '/camera' }],
  extraTopicRequirements: [{ topicId: 'camera', requirement: '30 Hz RGB' }],
  currentRevision: 'robotModels/arm/revisions/1',
});
const robotRevision = create(RobotModelRevisionSchema, {
  name: 'robotModels/arm/revisions/1',
  uid: '00000000-0000-4000-8000-000000000010',
  snapshot: robot,
  versionLabel: '1.0.0',
});
const frozen = create(FrozenDependencyContextSchema, {
  customers: [customer],
  materials: [material],
  scenes: [scene],
  globalFields: [globalField],
  materialStateRules: [materialStateRule],
  attachments: [attachment],
});
const taskSpec = create(TaskSopSpecSchema, {
  objects: [{
    id: 'cup',
    displayName: 'Cup',
    material: material.name,
    quantity: { amount: { case: 'fixedValue', value: 1 }, unit: 'piece' },
    materialDescriptor: { sku: 'CUP-1', category: 'container', color: 'blue', composition: 'ceramic', packaging: 'box' },
  }],
  robotState: { initial: 'idle', target: 'idle' },
  collection: {
    stepOrder: 'pick then place',
    steps: [{ id: 'pick', order: 1, description: '拿起杯子', englishDescription: 'Pick up the cup' }],
  },
  materialStateRules: [materialStateRule],
});
const task = create(TaskSopSchema, {
  name: 'taskSops/place-cup',
  uid: '00000000-0000-4000-8000-000000000008',
  displayName: 'Place cup',
  scene: scene.name,
  lifecycle: Lifecycle.CONFIRMED,
  spec: taskSpec,
  attachments: [attachment.name],
  currentRevision: 'taskSops/place-cup/revisions/1',
  referenceUris: ['https://records.example.com/1'],
  referenceAttachments: [{ fileToken: 'legacy-token', filename: 'legacy.zip', sizeBytes: 42n }],
});
const taskRevision = create(TaskSopRevisionSchema, {
  name: 'taskSops/place-cup/revisions/1',
  uid: '00000000-0000-4000-8000-000000000011',
  snapshot: task,
  versionLabel: '1.0.0',
  frozenDependencies: frozen,
  origin: RevisionOrigin.RUNTIME_CONFIRMED,
  exportEligible: true,
});
const requirementSpec = create(RequirementSpecSchema, {
  customer: customer.name,
  robotModelRevision: robotRevision.name,
  projectDisplayName: 'Demo',
  businessGoal: 'Collect data',
  delivery: { formats: ['mcap'], method: 'https', languages: [{ code: 'zh-CN', displayName: '中文' }] },
  annotation: { required: false },
  qualityInspection: { required: false },
  productionItems: [{
    id: 'place-cup',
    displayName: 'Place cup',
    taskSopRevision: taskRevision.name,
    target: { collectionCount: 10n },
    legacySceneName: 'Kitchen',
    legacySubsceneCode: 'place-cup',
    legacySubsceneName: 'Place cup',
    legacyVersionLabel: '1.0.0',
    legacyLifecycle: Lifecycle.CONFIRMED,
  }],
  priority: Priority.P1,
  aggregateTarget: { collectionCount: 10n },
  requestedSceneNames: ['Kitchen'],
  attachmentNotes: 'Use as reference',
  extraTopicRequirementsText: 'camera: 30 Hz RGB',
});
const requirement = create(RequirementSchema, {
  name: 'requirements/demo',
  uid: '00000000-0000-4000-8000-000000000009',
  displayName: 'Demo',
  lifecycle: Lifecycle.CONFIRMED,
  spec: requirementSpec,
  attachments: [attachment.name],
  currentRevision: 'requirements/demo/revisions/1',
});
const requirementRevision = create(RequirementRevisionSchema, {
  name: 'requirements/demo/revisions/1',
  uid: '00000000-0000-4000-8000-000000000012',
  snapshot: requirement,
  versionLabel: '1.0.0',
  frozenDependencies: frozen,
  origin: RevisionOrigin.RUNTIME_CONFIRMED,
  exportEligible: true,
});

describe('generated Proto runtime', () => {
  it('constructs every resource, spec, and immutable revision with frozen dependencies', () => {
    expect([
      customer,
      attachment,
      material,
      scene,
      globalField,
      materialStateRule,
      robot,
      robotRevision,
      taskSpec,
      task,
      taskRevision,
      requirementSpec,
      requirement,
      requirementRevision,
    ].every((message) => message.$typeName.startsWith('coscene.sop.v1alpha1.'))).toBe(true);
    expect(requirementRevision.frozenDependencies?.materials[0]?.size).toBe('10cm');
    expect(taskRevision.snapshot?.spec?.collection?.steps[0]?.englishDescription).toBe('Pick up the cup');
  });

  it('round-trips through schema-driven ProtoJSON while retaining presence and int64 values', () => {
    const json = toJson(RequirementRevisionSchema, requirementRevision);
    const decoded = fromJson(RequirementRevisionSchema, json);

    expect(decoded).toEqual(requirementRevision);
    expect(decoded.snapshot?.spec?.attachmentNotes).toBe('Use as reference');
    expect(decoded.snapshot?.spec?.productionItems[0]?.target?.collectionCount).toBe(10n);
    expect(decoded.previousRevision).toBeUndefined();
  });

  it('loads imported validation descriptors and evaluates field and CEL rules', () => {
    const validator = createValidator();
    const valid = validator.validate(OperationStepSchema, create(OperationStepSchema, {
      id: 'pick',
      order: 1,
      description: 'Pick up the cup',
    }));
    const invalid = validator.validate(OperationStepSchema, create(OperationStepSchema, {
      id: 'INVALID ID',
      order: 0,
      description: '',
    }));

    expect(valid.kind).toBe('valid');
    expect(invalid.kind).toBe('invalid');
    if (invalid.kind === 'invalid') expect(invalid.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('preserves explicit optional presence separately from scalar defaults', () => {
    const absent = create(MaterialSchema, { displayName: 'Cup' });
    const presentEmpty = create(MaterialSchema, { displayName: 'Cup', size: '' });

    expect(absent.size).toBeUndefined();
    expect(presentEmpty.size).toBe('');
    expect(toJson(MaterialSchema, absent)).not.toHaveProperty('size');
    expect(toJson(MaterialSchema, presentEmpty)).toHaveProperty('size', '');
  });

  it('enforces imported draft checkpoint and confirmed revision origin invariants', () => {
    const checkpoint = create(TaskSopRevisionSchema, {
      ...taskRevision,
      uid: '00000000-0000-4000-8000-000000000013',
      snapshot: { ...task, lifecycle: Lifecycle.DRAFT },
      origin: RevisionOrigin.IMPORTED_DRAFT_CHECKPOINT,
      exportEligible: false,
    });
    const validator = createValidator();
    expect(validator.validate(TaskSopRevisionSchema, checkpoint).kind).toBe('valid');
    expect(validator.validate(TaskSopRevisionSchema, { ...checkpoint, exportEligible: true }).kind).toBe('invalid');
    expect(validator.validate(TaskSopRevisionSchema, {
      ...checkpoint,
      origin: RevisionOrigin.IMPORTED_CONFIRMED,
      exportEligible: true,
    }).kind).toBe('invalid');
  });

  it('round-trips the normalized dependency review proposal through deterministic Proto binary', () => {
    const proposal = create(DependencyReviewProposalSchema, {
      rootName: 'taskSops/place-cup',
      rootEtag: 'etag-1',
      dependencies: [{
        kind: DependencyKind.MATERIAL,
        resourceName: 'materials/cup',
        token: 'etag-material-1',
      }],
    });
    const encoded = toBinary(DependencyReviewProposalSchema, proposal);
    expect(fromBinary(DependencyReviewProposalSchema, encoded)).toEqual(proposal);
    expect(createValidator().validate(DependencyReviewProposalSchema, proposal).kind).toBe('valid');
  });
});
