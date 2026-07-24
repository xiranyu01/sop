import { create, type JsonValue } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  AnnotationReadiness,
  Lifecycle,
  OperationRuleSchema,
} from '../../gen/coscene/sop/v1alpha1/common_pb';
import {
  RequirementRevisionSchema,
  RequirementSchema,
  RequirementSpecSchema,
  type Requirement as RequirementMessage,
} from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import {
  LegacyReferenceAttachmentSchema,
  TaskSopRevisionSchema,
  TaskSopSchema,
  TaskSopSpecSchema,
  type TaskSop as TaskSopMessage,
} from '../../gen/coscene/sop/v1alpha1/task_sop_pb';
import type { RevisionDetail } from '../../shared/transport/resourceDto';
import { fromDomainJson, toDomainJson } from '../../shared/domain/codec';
import { removeLegacySyntheticMaterialRandomizationConstraints } from '../../shared/domain/randomization';
import type {
  EntityStatus,
  MaterialStateRule,
  RequirementAttachment,
  RequirementVersion,
  SubsceneVersion,
  TextItem,
} from './viewModels';
import {
  changeFrequencyView,
  collectionCountView,
  dateView,
  durationHoursView,
  lifecycleView,
  optionalText,
  priorityView,
} from './protoFormMappings';

export type RevisionBound = {
  __revisionName?: string;
  __revisionExportEligible: boolean;
  __revisionCheckpoint: boolean;
};

export type TaskSopFormContext = {
  materialNameById?: ReadonlyMap<string, string>;
  attachmentNameById?: ReadonlyMap<string, string>;
  attachmentByName?: (name: string) => RequirementAttachment | undefined;
  materialStateRuleNameById?: ReadonlyMap<string, string>;
};

export type RequirementFormContext = {
  customerNameById?: ReadonlyMap<string, string>;
  robotRevisionNameById?: ReadonlyMap<string, string>;
  attachmentNameById?: ReadonlyMap<string, string>;
  attachmentByName?: (name: string) => RequirementAttachment | undefined;
  taskRevisionName?: (item: RequirementVersion['selectedSubscenes'][number]) => string | undefined;
};

function sourceId(message: { sourceId?: string; name: string }): string {
  return message.sourceId || resourceTail(message.name);
}

function resourceTail(name: string): string {
  return name.split('/').at(-1) || name;
}

function rootTail(name: string): string {
  return name.split('/')[1] || resourceTail(name);
}

function timestamp(value?: Parameters<typeof timestampDate>[0]): string {
  return value ? timestampDate(value).toISOString() : new Date(0).toISOString();
}

function safeId(value: string | undefined, fallback: string): string {
  const normalized = (value || fallback)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return normalized || fallback;
}

function attachmentPlaceholder(name: string): RequirementAttachment {
  const id = resourceTail(name);
  return {
    id,
    name: '附件信息暂不可用',
    size: 0,
    contentType: '',
    storageKey: '',
    uploadedAt: '',
  };
}

function revisionBound<T extends object>(
  value: T,
  metadata: { name?: string; exportEligible?: boolean; checkpoint?: boolean },
): T & RevisionBound {
  return Object.assign(value, {
    __revisionName: metadata.name,
    __revisionExportEligible: Boolean(metadata.exportEligible),
    __revisionCheckpoint: Boolean(metadata.checkpoint),
  });
}

export function revisionNameOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const name = (value as Partial<RevisionBound>).__revisionName;
  return typeof name === 'string' && name ? name : undefined;
}

export function revisionExportEligible(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Partial<RevisionBound>).__revisionExportEligible);
}

export function revisionIsCheckpoint(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Partial<RevisionBound>).__revisionCheckpoint);
}

function status(lifecycle: Lifecycle): EntityStatus {
  return lifecycleView.fromProto(lifecycle);
}

function taskVersion(
  task: TaskSopMessage,
  versionLabel: string,
  metadata: {
    name?: string;
    exportEligible?: boolean;
    checkpoint?: boolean;
    versionId?: string;
    sourceVersionId?: string;
    parentSourceVersionId?: string;
    createdAt?: string;
  },
  context: TaskSopFormContext,
): SubsceneVersion & RevisionBound {
  const spec = task.spec;
  if (!spec) throw new TypeError(`TaskSop ${task.name || '<new>'} has no spec`);
  const objectDisplay = new Map(spec.objects.map((item) => [item.id, item.displayName]));
  const objectValue = (id: string) => objectDisplay.get(id) || '';
  const reference = (item: NonNullable<NonNullable<typeof spec.objectStates>['initial'][number]['allowedLocations'][number]>['referencePath'][number]) => ({
    level: item.level,
    referenceObject: item.referenceObject || (item.objectId ? objectValue(item.objectId) : ''),
    relativePosition: item.relativePosition || '',
  });
  const location = (item: NonNullable<NonNullable<typeof spec.objectStates>['initial'][number]['allowedLocations'][number]>) => ({
    location: item.displayName || '',
    referencePath: item.referencePath.map(reference),
    supportSurface: item.supportSurface || '',
    allowedRegions: [...item.regions],
    allowedPose: [...item.poses],
    allowedForm: [...item.forms],
    parameters: item.parameters.flatMap((parameter) => parameter.values),
    collectorInstruction: item.collectorInstruction,
    exampleImageAttachmentIds: item.exampleImages.map(resourceTail),
    constraints: [...item.constraints],
  });
  const steps = (items: NonNullable<typeof spec.collection>['steps']) => items.map((step) => ({
    order: step.order,
    description: step.description,
    atomicSkill: step.atomicSkill,
    englishDescription: step.englishDescription,
    englishAtomicSkill: step.englishAtomicSkill,
  }));
  const textItems = (items: Array<{ category?: string; description: string }>): TextItem[] => items.map((item) => ({
    type: item.category,
    description: item.description,
  }));
  const result: SubsceneVersion = {
    version: versionLabel,
    versionId: metadata.versionId || metadata.sourceVersionId,
    parentVersionId: metadata.parentSourceVersionId,
    createdAt: metadata.createdAt || timestamp(task.candidateCreateTime) || timestamp(task.updateTime) || timestamp(task.createTime),
    status: status(task.lifecycle),
    title: task.displayName,
    sceneName: task.legacySceneDisplayName,
    subsceneName: task.legacySubsceneDisplayName,
    description: task.description || '',
    attachments: task.attachments.map((name) => context.attachmentByName?.(name) ?? attachmentPlaceholder(name)),
    requiredDurationHours: durationHoursView.fromProto(spec.expectedDuration),
    materials: spec.objects.map((object) => {
      const amount = object.quantity?.amount;
      return {
        materialId: object.material ? rootTail(object.material) : '',
        skuId: object.materialDescriptor?.sku || '',
        type: object.materialDescriptor?.category || object.displayName,
        quantity: amount?.case === 'range'
          ? { mode: 'range' as const, min: amount.value.minValue, max: amount.value.maxValue, unit: object.quantity?.unit || '' }
          : { mode: 'fixed' as const, value: amount?.case === 'fixedValue' ? amount.value : 0, unit: object.quantity?.unit || '' },
        color: object.materialDescriptor?.color || '',
        material: object.materialDescriptor?.composition || '',
        packageType: object.materialDescriptor?.packaging || '',
      };
    }),
    robotState: { initial: spec.robotState?.initial || '', target: spec.robotState?.target || '' },
    robotOperationRequirements: spec.robotOperationRequirements,
    robotInitialRandomizationRequirements: [...spec.robotInitialRandomizationRequirements],
    randomizationFrequency: spec.legacyRandomizationFrequency,
    randomization: {
      robotInitialState: {
        enabled: spec.randomization?.robotInitialState?.enabled ?? false,
        changeFrequency: spec.randomization?.robotInitialState?.change
          ? changeFrequencyView.fromProto(spec.randomization.robotInitialState.change.frequency)
          : 'fixed',
        changeIntervalRecords: spec.randomization?.robotInitialState?.change?.intervalRecords,
        randomizedFields: (spec.randomization?.robotInitialState?.fields ?? []).map((field) => ({
          field: field.fieldId,
          displayName: field.displayName || field.fieldId,
          constraints: [...field.constraints],
        })),
      },
      materialInitialState: {
        rules: (spec.randomization?.objectInitialStates ?? []).map((rule) => ({
          targetMaterials: rule.objectIds.map(objectValue),
          changeFrequency: rule.change ? changeFrequencyView.fromProto(rule.change.frequency) : 'fixed',
          changeIntervalRecords: rule.change?.intervalRecords,
          randomizedFields: {
            locations: rule.locations.map((item) => ({ name: item.name, valueSource: item.valueSource })),
            poses: rule.poses.map((item) => ({ name: item.name, valueSource: item.valueSource })),
            forms: rule.forms.map((item) => ({ name: item.name, valueSource: item.valueSource })),
          },
          collectorInstruction: rule.collectorInstruction,
          exampleImageAttachmentIds: rule.exampleImages.map(resourceTail),
          constraints: removeLegacySyntheticMaterialRandomizationConstraints(rule.constraints),
        })),
      },
    },
    operation: {
      stepOrder: spec.collection?.stepOrder || '',
      steps: steps(spec.collection?.steps ?? []),
      stepRandomization: spec.collection?.stepRandomization ? {
        enabled: spec.collection.stepRandomization.enabled,
        startOrder: spec.collection.stepRandomization.startStepNumber || 1,
        endOrder: spec.collection.stepRandomization.endStepNumber || 1,
      } : undefined,
      allowedOperations: textItems(spec.collection?.policy?.allowed ?? []),
      acceptableOperations: textItems(spec.collection?.policy?.acceptable ?? []),
      forbiddenOperations: textItems(spec.collection?.policy?.forbidden ?? []),
    },
    objectStates: {
      initial: (spec.objectStates?.initial ?? []).map((state) => ({
        object: objectValue(state.objectId),
        allowedLocations: state.allowedLocations.map(location),
      })),
      target: (spec.objectStates?.target ?? []).map((state) => ({
        object: objectValue(state.objectId),
        requiredLocation: state.requiredLocation?.displayName || '',
        requiredRegions: [...(state.requiredLocation?.regions ?? [])],
        requiredPose: [...(state.requiredLocation?.poses ?? [])],
        requiredForm: [...(state.requiredLocation?.forms ?? [])],
        referencePath: (state.requiredLocation?.referencePath ?? []).map(reference),
        supportSurface: state.requiredLocation?.supportSurface,
        parameters: state.requiredLocation?.parameters.flatMap((parameter) => parameter.values),
        collectorInstruction: state.requiredLocation?.collectorInstruction,
        exampleImageAttachmentIds: (state.requiredLocation?.exampleImages ?? []).map(resourceTail),
        constraints: [...(state.requiredLocation?.constraints ?? [])],
      })),
    },
    materialStateRules: spec.materialStateRules.map((rule): MaterialStateRule => ({
      id: sourceId(rule),
      materialType: rule.materialType,
      primaryReferences: [...rule.primaryReferences],
      primaryRelativePositions: [...rule.primaryRelativePositions],
      supportSurfaces: [...rule.supportSurfaces],
      regions: [...rule.regions],
      secondaryReferences: [...rule.secondaryReferences],
      secondaryRelativePositions: [...rule.secondaryRelativePositions],
      poses: [...rule.poses],
      forms: [...rule.forms],
      parameters: [...rule.parameters],
      updatedAt: timestamp(rule.updateTime),
    })),
    annotation: {
      status: spec.annotation?.readiness === AnnotationReadiness.READY ? 'ready'
        : spec.annotation?.readiness === AnnotationReadiness.NOT_REQUIRED ? 'not_required' : 'pending',
      note: spec.annotation?.note || '',
      actionTags: [...(spec.annotation?.actionTags ?? [])],
      steps: steps(spec.annotation?.steps ?? []),
      allowedOperations: textItems(spec.annotation?.policy?.allowed ?? []),
      forbiddenOperations: textItems(spec.annotation?.policy?.forbidden ?? []),
      stepRandomization: spec.annotation?.stepRandomization ? {
        enabled: spec.annotation.stepRandomization.enabled,
        startOrder: spec.annotation.stepRandomization.startStepNumber || 1,
        endOrder: spec.annotation.stepRandomization.endStepNumber || 1,
      } : undefined,
    },
    references: {
      recordUrls: [...task.referenceUris],
      attachments: task.referenceAttachments.map((item) => ({
        fileToken: item.fileToken,
        name: item.filename,
        size: Number(item.sizeBytes),
      })),
    },
    updatedAt: timestamp(task.updateTime),
  };
  return revisionBound(result, metadata);
}

function revisionParentId(details: RevisionDetail[], previous?: string): string | undefined {
  const parent = previous ? details.find((item) => item.name === previous) : undefined;
  return parent?.uid || parent?.sourceVersionId;
}

function compareVersions(left: { version: string }, right: { version: string }): number {
  return left.version.localeCompare(right.version, undefined, { numeric: true });
}

export function decodeTaskSopVersions(
  currentResource: JsonValue,
  revisions: RevisionDetail[],
  context: TaskSopFormContext = {},
): Array<SubsceneVersion & RevisionBound> {
  const current = fromDomainJson(TaskSopSchema, currentResource);
  const values = revisions.map((detail) => {
    const revision = fromDomainJson(TaskSopRevisionSchema, detail.resource);
    if (!revision.snapshot) throw new TypeError(`TaskSop revision has no snapshot: ${detail.name}`);
    return taskVersion(revision.snapshot, revision.versionLabel || detail.versionLabel, {
      name: detail.name,
      exportEligible: detail.exportEligible,
      checkpoint: !detail.exportEligible,
      versionId: detail.uid,
      sourceVersionId: revision.sourceVersionId || detail.sourceVersionId,
      parentSourceVersionId: revisionParentId(revisions, revision.previousRevision || detail.previousRevisionName),
      createdAt: timestamp(revision.createTime) || detail.createdAt,
    }, context);
  });
  if (current.lifecycle === Lifecycle.DRAFT) {
    values.push(taskVersion(current, current.candidateVersionLabel || '0.0.1', {
      exportEligible: false,
      versionId: current.uid,
      sourceVersionId: current.candidateSourceVersionId,
      parentSourceVersionId: revisionParentId(revisions, current.currentRevision),
      createdAt: timestamp(current.candidateCreateTime) || timestamp(current.updateTime) || timestamp(current.createTime),
    }, context));
  }
  return values.sort(compareVersions);
}

export function decodeTaskSopIdentity(currentResource: JsonValue): {
  id: string;
  code: string;
  displayName: string;
  sceneName: string;
} {
  const current = fromDomainJson(TaskSopSchema, currentResource);
  return {
    id: sourceId(current),
    code: current.legacySubsceneCode || sourceId(current),
    displayName: current.legacySubsceneDisplayName || current.displayName,
    sceneName: current.scene,
  };
}

function requirementVersion(
  requirement: RequirementMessage,
  versionLabel: string,
  metadata: {
    name?: string;
    exportEligible?: boolean;
    checkpoint?: boolean;
    versionId?: string;
    sourceVersionId?: string;
    parentSourceVersionId?: string;
    createdAt?: string;
  },
  context: RequirementFormContext,
): RequirementVersion & RevisionBound {
  const spec = requirement.spec;
  if (!spec) throw new TypeError(`Requirement ${requirement.name || '<new>'} has no spec`);
  const operationRows = (items: Array<{ description: string; note?: string }>) => items.map((item) => ({ operation: item.description, note: item.note || '' }));
  const forbidden = new Map<string, Array<{ operation: string; note: string }>>();
  for (const item of spec.globalRequirements?.collectionPolicy?.forbidden ?? []) {
    const category = item.category || '';
    forbidden.set(category, [...(forbidden.get(category) ?? []), { operation: item.description, note: item.note || '' }]);
  }
  const result: RequirementVersion = {
    version: versionLabel,
    versionId: metadata.versionId || metadata.sourceVersionId,
    parentVersionId: metadata.parentSourceVersionId,
    createdAt: metadata.createdAt || timestamp(requirement.candidateCreateTime) || timestamp(requirement.updateTime) || timestamp(requirement.createTime),
    status: status(requirement.lifecycle),
    title: requirement.displayName,
    projectName: spec.projectDisplayName || '',
    priority: priorityView.fromProto(spec.priority),
    deadline: dateView.fromProto(spec.deadline),
    sourceBaseUrl: spec.sourceUri,
    attachmentNotes: spec.attachmentNotes,
    attachments: requirement.attachments.map((name) => context.attachmentByName?.(name) ?? attachmentPlaceholder(name)),
    extraTopicRequirementsText: spec.extraTopicRequirementsText,
    globalRandomizationRequirements: spec.globalRequirements?.randomizationNotes || '',
    additionalNotes: spec.globalRequirements?.additionalNotes || '',
    customerId: spec.customer ? rootTail(spec.customer) : '',
    robotModelId: spec.robotModelRevision ? rootTail(spec.robotModelRevision) : '',
    businessGoal: spec.businessGoal,
    requestedScenes: [...spec.requestedSceneNames],
    requiredDurationHours: durationHoursView.fromProto(spec.aggregateTarget?.duration),
    allowedOperations: operationRows(spec.globalRequirements?.collectionPolicy?.allowed ?? []),
    acceptableOperations: operationRows(spec.globalRequirements?.collectionPolicy?.acceptable ?? []),
    forbiddenOperations: [...forbidden].map(([category, operations]) => ({ category, operations })),
    annotation: {
      required: spec.annotation?.required,
      types: [...(spec.annotation?.types ?? [])],
      allowedOperations: operationRows(spec.globalRequirements?.annotationPolicy?.allowed ?? []),
      forbiddenOperations: operationRows(spec.globalRequirements?.annotationPolicy?.forbidden ?? []),
    },
    qualityInspection: {
      required: spec.qualityInspection?.required ?? true,
      samplingPolicy: spec.qualityInspection?.samplingPolicy || '',
    },
    delivery: {
      formats: [...(spec.delivery?.formats ?? [])],
      method: spec.delivery?.method || '',
      languages: (spec.delivery?.languages ?? []).map((item) => ({ code: item.code, name: item.displayName || '' })),
      dataStructureUrl: spec.delivery?.dataStructureUri || '',
    },
    selectedSubscenes: spec.productionItems.map((item) => ({
      id: item.id,
      title: item.displayName,
      description: item.description,
      subsceneCode: item.legacySubsceneCode,
      subsceneName: item.legacySubsceneName,
      sceneName: item.legacySceneName || '',
      version: item.legacyVersionLabel,
      targetDurationHours: durationHoursView.fromProto(item.target?.duration),
      targetCollectionCount: collectionCountView.fromProto(item.target?.collectionCount),
      taskSop: item.taskSopRevision ? {
        sceneName: item.legacySceneName || '',
        title: item.legacySubsceneName || item.displayName,
        version: item.legacyVersionLabel || '',
        versionId: item.legacyVersionId,
        parentVersionId: item.legacyParentVersionId,
        status: item.legacyLifecycle ? status(item.legacyLifecycle) : undefined,
      } : undefined,
    })),
    updatedAt: timestamp(requirement.updateTime),
  };
  return revisionBound(result, metadata);
}

export function decodeRequirementVersions(
  currentResource: JsonValue,
  revisions: RevisionDetail[],
  context: RequirementFormContext = {},
): Array<RequirementVersion & RevisionBound> {
  const current = fromDomainJson(RequirementSchema, currentResource);
  const values = revisions.map((detail) => {
    const revision = fromDomainJson(RequirementRevisionSchema, detail.resource);
    if (!revision.snapshot) throw new TypeError(`Requirement revision has no snapshot: ${detail.name}`);
    return requirementVersion(revision.snapshot, revision.versionLabel || detail.versionLabel, {
      name: detail.name,
      exportEligible: detail.exportEligible,
      checkpoint: !detail.exportEligible,
      versionId: detail.uid,
      sourceVersionId: revision.sourceVersionId || detail.sourceVersionId,
      parentSourceVersionId: revisionParentId(revisions, revision.previousRevision || detail.previousRevisionName),
      createdAt: timestamp(revision.createTime) || detail.createdAt,
    }, context);
  });
  if (current.lifecycle === Lifecycle.DRAFT) {
    values.push(requirementVersion(current, current.candidateVersionLabel || '0.0.1', {
      exportEligible: false,
      versionId: current.uid,
      sourceVersionId: current.candidateSourceVersionId,
      parentSourceVersionId: revisionParentId(revisions, current.currentRevision),
      createdAt: timestamp(current.candidateCreateTime) || timestamp(current.updateTime) || timestamp(current.createTime),
    }, context));
  }
  return values.sort(compareVersions);
}

export function decodeRequirementId(currentResource: JsonValue): string {
  return sourceId(fromDomainJson(RequirementSchema, currentResource));
}

function operationRules(items: TextItem[] | undefined, prefix: string) {
  return (items ?? []).flatMap((item, index) => item.description || item.type ? [create(OperationRuleSchema, {
    id: safeId(`${prefix}-${index + 1}`, `${prefix}-${index + 1}`),
    description: item.description,
    category: optionalText(item.type),
  })] : []);
}

function requirementRules(
  items: Array<{ operation: string; note: string }> | undefined,
  prefix: string,
  category?: string,
 ) {
  return (items ?? []).flatMap((item, index) => item.operation || item.note || category ? [create(OperationRuleSchema, {
    id: safeId(`${prefix}-${index + 1}`, `${prefix}-${index + 1}`),
    description: item.operation,
    category: optionalText(category),
    note: optionalText(item.note),
  })] : []);
}

function attachmentNames(current: string[], context?: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...current.map((name) => [resourceTail(name), name] as const), ...(context ? [...context] : [])]);
}

function buildTaskSpec(version: SubsceneVersion, current: TaskSopMessage, context: TaskSopFormContext) {
  const aliases = new Map<string, string>();
  const currentObjectsById = new Map((current.spec?.objects ?? []).map((object) => [object.id, object]));
  const objects = version.materials.map((item, index) => {
    const id = safeId(item.materialId || item.type, `object-${index + 1}`);
    const previous = currentObjectsById.get(id);
    if (item.materialId) aliases.set(item.materialId, id);
    if (item.type) aliases.set(item.type, id);
    return {
      id,
      displayName: item.type || item.skuId || id,
      material: context.materialNameById?.get(item.materialId),
      quantity: {
        amount: item.quantity.mode === 'range'
          ? { case: 'range' as const, value: { minValue: item.quantity.min ?? 0, maxValue: item.quantity.max ?? 0 } }
          : { case: 'fixedValue' as const, value: item.quantity.value ?? 0 },
        unit: item.quantity.unit || 'unit',
      },
      roles: previous?.roles ?? [],
      attributes: previous?.attributes ?? [],
      images: previous?.images ?? [],
      materialDescriptor: {
        sku: optionalText(item.skuId),
        category: optionalText(item.type),
        color: optionalText(item.color),
        composition: optionalText(item.material),
        packaging: optionalText(item.packageType),
        size: previous?.materialDescriptor?.size,
        weight: previous?.materialDescriptor?.weight,
      },
    };
  });
  const objectId = (alias: string, fallback: string) => aliases.get(alias) || safeId(alias, fallback);
  const attachmentById = attachmentNames(current.attachments, context.attachmentNameById);
  const images = (ids: string[] | undefined) => (ids ?? []).flatMap((id) => attachmentById.get(id) ?? []);
  const relation = (item: { referenceObject: string; relativePosition: string; level: number }) => ({
    objectId: aliases.get(item.referenceObject),
    referenceObject: optionalText(item.referenceObject),
    relativePosition: optionalText(item.relativePosition),
    level: item.level,
  });
  const location = (item: SubsceneVersion['objectStates']['initial'][number]['allowedLocations'][number]) => ({
    displayName: optionalText(item.location),
    referencePath: item.referencePath.map((value) => relation(value)),
    supportSurface: optionalText(item.supportSurface),
    regions: item.allowedRegions,
    poses: item.allowedPose,
    forms: item.allowedForm,
    parameters: (item.parameters ?? []).map((value, index) => ({ key: `value-${index + 1}`, values: [value] })),
    collectorInstruction: optionalText(item.collectorInstruction),
    exampleImages: images(item.exampleImageAttachmentIds),
    constraints: item.constraints,
  });
  const steps = (items: SubsceneVersion['operation']['steps'] | undefined, prefix: string) => (items ?? []).map((step, index) => ({
    id: safeId(`${prefix}-${step.order || index + 1}`, `${prefix}-${index + 1}`),
    order: step.order || index + 1,
    description: step.description,
    atomicSkill: optionalText(step.atomicSkill),
    englishDescription: optionalText(step.englishDescription),
    englishAtomicSkill: optionalText(step.englishAtomicSkill),
  }));
  const ruleNames = new Map((current.spec?.materialStateRules ?? []).map((rule) => [sourceId(rule), rule.name]));
  return {
    objects,
    robotState: version.robotState,
    objectStates: {
      initial: version.objectStates.initial.map((state, index) => ({
        objectId: objectId(state.object, `draft-object-${index + 1}`),
        allowedLocations: state.allowedLocations.map((item) => location(item)),
      })),
      target: version.objectStates.target.map((state, index) => ({
        objectId: objectId(state.object, `draft-object-${index + 1}`),
        requiredLocation: {
          displayName: optionalText(state.requiredLocation),
          referencePath: (state.referencePath ?? []).map((item) => relation(item)),
          supportSurface: optionalText(state.supportSurface),
          regions: state.requiredRegions,
          poses: state.requiredPose,
          forms: state.requiredForm,
          parameters: (state.parameters ?? []).map((value, parameterIndex) => ({ key: `value-${parameterIndex + 1}`, values: [value] })),
          collectorInstruction: optionalText(state.collectorInstruction),
          exampleImages: images(state.exampleImageAttachmentIds),
          constraints: state.constraints ?? [],
        },
      })),
    },
    randomization: {
      robotInitialState: {
        enabled: version.randomization.robotInitialState.enabled,
        change: version.randomization.robotInitialState.enabled ? {
          frequency: changeFrequencyView.toProto(version.randomization.robotInitialState.changeFrequency),
          intervalRecords: version.randomization.robotInitialState.changeIntervalRecords,
        } : undefined,
        fields: version.randomization.robotInitialState.randomizedFields.map((field, index) => ({
          fieldId: safeId(field.field, `field-${index + 1}`),
          displayName: optionalText(field.displayName),
          constraints: field.constraints,
        })),
      },
      objectInitialStates: version.randomization.materialInitialState.rules.map((rule, index) => ({
        objectIds: rule.targetMaterials.map((alias, aliasIndex) => objectId(alias, `draft-object-${index + 1}-${aliasIndex + 1}`)),
        change: {
          frequency: changeFrequencyView.toProto(rule.changeFrequency),
          intervalRecords: rule.changeIntervalRecords,
        },
        fields: [
          ...rule.randomizedFields.locations,
          ...rule.randomizedFields.poses,
          ...rule.randomizedFields.forms,
        ].map((item, itemIndex) => ({
          fieldId: safeId(item.name, `field-${index + 1}-${itemIndex + 1}`),
          displayName: item.name,
          constraints: item.valueSource ? [`value_source=${item.valueSource}`] : [],
        })),
        collectorInstruction: optionalText(rule.collectorInstruction),
        constraints: rule.constraints,
        exampleImages: images(rule.exampleImageAttachmentIds),
        locations: rule.randomizedFields.locations,
        poses: rule.randomizedFields.poses,
        forms: rule.randomizedFields.forms,
      })),
    },
    collection: {
      stepOrder: optionalText(version.operation.stepOrder),
      steps: steps(version.operation.steps, 'step'),
      policy: {
        allowed: operationRules(version.operation.allowedOperations, 'allowed'),
        acceptable: operationRules(version.operation.acceptableOperations, 'acceptable'),
        forbidden: operationRules(version.operation.forbiddenOperations, 'forbidden'),
      },
      stepRandomization: version.operation.stepRandomization
        ? version.operation.stepRandomization.enabled
          ? { enabled: true, startStepNumber: version.operation.stepRandomization.startOrder, endStepNumber: version.operation.stepRandomization.endOrder }
          : { enabled: false }
        : undefined,
    },
    annotation: {
      readiness: {
        pending: AnnotationReadiness.PENDING,
        ready: AnnotationReadiness.READY,
        not_required: AnnotationReadiness.NOT_REQUIRED,
      }[version.annotation.status],
      note: optionalText(version.annotation.note),
      actionTags: version.annotation.actionTags,
      steps: steps(version.annotation.steps, 'annotation-step'),
      policy: {
        allowed: operationRules(version.annotation.allowedOperations, 'annotation-allowed'),
        forbidden: operationRules(version.annotation.forbiddenOperations, 'annotation-forbidden'),
      },
      stepRandomization: version.annotation.stepRandomization
        ? version.annotation.stepRandomization.enabled
          ? { enabled: true, startStepNumber: version.annotation.stepRandomization.startOrder, endStepNumber: version.annotation.stepRandomization.endOrder }
          : { enabled: false }
        : undefined,
    },
    expectedDuration: durationHoursView.toProto(version.requiredDurationHours ?? 0),
    robotOperationRequirements: optionalText(version.robotOperationRequirements),
    robotInitialRandomizationRequirements: version.robotInitialRandomizationRequirements ?? [],
    legacyRandomizationFrequency: optionalText(version.randomizationFrequency),
    materialStateRules: (version.materialStateRules ?? []).map((rule) => ({
      name: context.materialStateRuleNameById?.get(rule.id) || ruleNames.get(rule.id) || '',
      sourceId: rule.id,
      materialType: rule.materialType,
      primaryReferences: rule.primaryReferences,
      primaryRelativePositions: rule.primaryRelativePositions,
      supportSurfaces: rule.supportSurfaces,
      regions: rule.regions,
      secondaryReferences: rule.secondaryReferences,
      secondaryRelativePositions: rule.secondaryRelativePositions,
      poses: rule.poses,
      forms: rule.forms,
      parameters: rule.parameters,
    })),
  };
}

export function encodeTaskSopVersion(
  version: SubsceneVersion,
  currentResource: JsonValue,
  context: TaskSopFormContext = {},
): JsonValue {
  const current = fromDomainJson(TaskSopSchema, currentResource);
  return toDomainJson(TaskSopSchema, create(TaskSopSchema, {
    ...current,
    displayName: version.title,
    description: optionalText(version.description),
    spec: create(TaskSopSpecSchema, buildTaskSpec(version, current, context) as never),
    attachments: (version.attachments ?? []).flatMap((item) => context.attachmentNameById?.get(item.id) ||
      current.attachments.find((name) => resourceTail(name) === item.id) || []),
    referenceUris: version.references.recordUrls,
    referenceAttachments: version.references.attachments.map((item) => create(LegacyReferenceAttachmentSchema, {
      fileToken: item.fileToken,
      filename: item.name,
      sizeBytes: BigInt(item.size),
    })),
    legacySceneDisplayName: optionalText(version.sceneName),
    legacySubsceneDisplayName: optionalText(version.subsceneName),
  }));
}

export function createTaskSopResource(
  version: SubsceneVersion,
  sceneName: string,
  subsceneCode: string,
  context: TaskSopFormContext = {},
): JsonValue {
  const empty = create(TaskSopSchema, {
    displayName: version.title,
    scene: sceneName,
    lifecycle: Lifecycle.DRAFT,
    legacySubsceneCode: subsceneCode,
    legacySceneDisplayName: optionalText(version.sceneName),
    legacySubsceneDisplayName: optionalText(version.subsceneName),
  });
  return encodeTaskSopVersion(version, toDomainJson(TaskSopSchema, empty), context);
}

function currentProductionItems(current: RequirementMessage): Map<string, NonNullable<RequirementMessage['spec']>['productionItems'][number]> {
  return new Map((current.spec?.productionItems ?? []).map((item) => [item.id, item]));
}

export function encodeRequirementVersion(
  version: RequirementVersion,
  currentResource: JsonValue,
  context: RequirementFormContext = {},
): JsonValue {
  const current = fromDomainJson(RequirementSchema, currentResource);
  const currentItems = currentProductionItems(current);
  const attachmentById = attachmentNames(current.attachments, context.attachmentNameById);
  const productionItems = version.selectedSubscenes.map((item, index) => {
    const id = safeId(item.id || item.subsceneCode || `item-${index + 1}`, `item-${index + 1}`);
    const previous = currentItems.get(id);
    const duration = durationHoursView.toProto(item.targetDurationHours);
    const collectionCount = collectionCountView.toProto(item.targetCollectionCount || 0);
    return {
      id,
      displayName: item.title || item.subsceneName || `生产需求项 ${index + 1}`,
      description: optionalText(item.description),
      taskSopRevision: context.taskRevisionName?.(item) || previous?.taskSopRevision || '',
      target: duration || collectionCount !== undefined ? { duration, collectionCount } : undefined,
      legacySceneName: optionalText(item.taskSop?.sceneName || item.sceneName),
      legacySubsceneCode: optionalText(item.subsceneCode),
      legacySubsceneName: optionalText(item.taskSop?.title || item.subsceneName),
      legacyVersionLabel: optionalText(item.taskSop?.version || item.version),
      legacyVersionId: optionalText(item.taskSop?.versionId),
      legacyParentVersionId: optionalText(item.taskSop?.parentVersionId),
      legacyLifecycle: item.taskSop?.status ? lifecycleView.toProto(item.taskSop.status) : undefined,
    };
  });
  const currentSpec = current.spec;
  const customer = context.customerNameById?.get(version.customerId) ||
    (currentSpec && rootTail(currentSpec.customer) === version.customerId ? currentSpec.customer : '');
  const robotRevision = context.robotRevisionNameById?.get(version.robotModelId) ||
    (currentSpec && rootTail(currentSpec.robotModelRevision) === version.robotModelId ? currentSpec.robotModelRevision : '');
  const aggregateDuration = version.requiredDurationHours > 0
    ? durationHoursView.toProto(version.requiredDurationHours)
    : undefined;
  const aggregateCollectionCount = currentSpec?.aggregateTarget?.collectionCount;
  const aggregateTarget = aggregateDuration || aggregateCollectionCount !== undefined
    ? {
      duration: aggregateDuration,
      collectionCount: aggregateCollectionCount,
    }
    : undefined;
  const spec = {
    customer,
    robotModelRevision: robotRevision,
    projectDisplayName: optionalText(version.projectName),
    businessGoal: version.businessGoal,
    deadline: dateView.toProto(version.deadline),
    sourceUri: optionalText(version.sourceBaseUrl),
    priority: priorityView.toProto(version.priority),
    requestedSceneNames: version.requestedScenes,
    aggregateTarget,
    attachmentNotes: optionalText(version.attachmentNotes),
    extraTopicRequirementsText: optionalText(version.extraTopicRequirementsText),
    productionItems,
    globalRequirements: {
      topics: currentSpec?.globalRequirements?.topics ?? [],
      randomizationNotes: optionalText(version.globalRandomizationRequirements),
      additionalNotes: optionalText(version.additionalNotes),
      collectionPolicy: {
        allowed: requirementRules(version.allowedOperations, 'allowed'),
        acceptable: requirementRules(version.acceptableOperations, 'acceptable'),
        forbidden: version.forbiddenOperations.flatMap((group, index) =>
          requirementRules(group.operations, `forbidden-${index + 1}`, group.category)),
      },
      annotationPolicy: {
        allowed: requirementRules(version.annotation.allowedOperations, 'annotation-allowed'),
        forbidden: requirementRules(version.annotation.forbiddenOperations, 'annotation-forbidden'),
      },
    },
    delivery: {
      formats: version.delivery.formats,
      method: optionalText(version.delivery.method),
      languages: version.delivery.languages.map((item) => ({ code: item.code, displayName: optionalText(item.name) })),
      dataStructureUri: optionalText(version.delivery.dataStructureUrl),
    },
    annotation: { required: version.annotation.required, types: version.annotation.types },
    qualityInspection: {
      required: version.qualityInspection.required,
      samplingPolicy: optionalText(version.qualityInspection.samplingPolicy),
    },
  };
  return toDomainJson(RequirementSchema, create(RequirementSchema, {
    ...current,
    displayName: version.title,
    attachments: (version.attachments ?? []).flatMap((item) => attachmentById.get(item.id) ?? []),
    spec: create(RequirementSpecSchema, spec as never),
  }));
}

export function createRequirementResource(
  version: RequirementVersion,
  context: RequirementFormContext = {},
): JsonValue {
  const empty = create(RequirementSchema, {
    displayName: version.title,
    lifecycle: Lifecycle.DRAFT,
  });
  return encodeRequirementVersion(version, toDomainJson(RequirementSchema, empty), context);
}
