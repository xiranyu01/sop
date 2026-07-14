import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { Timestamp } from '@bufbuild/protobuf/wkt';
import { defaultAppMetadata } from '../../../src/schemaVersions';
import type {
  AppData,
  ChangeFrequency as LegacyChangeFrequency,
  EntityStatus,
  GlobalFieldGroup as LegacyGlobalFieldGroup,
  Priority as LegacyPriority,
  RequirementAttachment,
  RequirementVersion,
  SubsceneVersion,
} from '../../../src/types';
import {
  AnnotationReadiness,
  ChangeFrequency,
  GlobalFieldGroup,
  GlobalFieldStatus,
  Lifecycle,
  Priority,
} from '../../../gen/coscene/sop/v1alpha1/common_pb';
import type { CanonicalSnapshot } from '../appStore';

const lifecycleMap: Record<number, EntityStatus> = {
  [Lifecycle.DRAFT]: 'draft',
  [Lifecycle.CONFIRMED]: 'confirmed',
  [Lifecycle.ARCHIVED]: 'archived',
};

const priorityMap: Record<number, LegacyPriority> = {
  [Priority.P0]: 'P0', [Priority.P1]: 'P1', [Priority.P2]: 'P2', [Priority.P3]: 'P3',
};

const frequencyMap: Record<number, LegacyChangeFrequency> = {
  [ChangeFrequency.EVERY_RECORD]: 'every_record',
  [ChangeFrequency.EVERY_N_RECORDS]: 'every_n_records',
  [ChangeFrequency.PER_BATCH]: 'per_batch',
  [ChangeFrequency.FIXED]: 'fixed',
};

const fieldGroupMap: Record<number, LegacyGlobalFieldGroup> = {
  [GlobalFieldGroup.ROBOT_STATE]: 'robot_state',
  [GlobalFieldGroup.REFERENCE_OBJECT]: 'reference_object',
  [GlobalFieldGroup.RELATIVE_POSITION]: 'relative_position',
  [GlobalFieldGroup.SUPPORT_SURFACE]: 'support_surface',
  [GlobalFieldGroup.REGION]: 'region',
  [GlobalFieldGroup.POSE]: 'pose',
  [GlobalFieldGroup.FORM]: 'form',
  [GlobalFieldGroup.PARAMETER]: 'parameter',
  [GlobalFieldGroup.ALLOWED_OPERATION]: 'allowed_operation',
  [GlobalFieldGroup.ACCEPTABLE_OPERATION]: 'acceptable_operation',
  [GlobalFieldGroup.FORBIDDEN_OPERATION]: 'forbidden_operation',
  [GlobalFieldGroup.ANNOTATION_ALLOWED_OPERATION]: 'annotation_allowed_operation',
  [GlobalFieldGroup.ANNOTATION_FORBIDDEN_OPERATION]: 'annotation_forbidden_operation',
  [GlobalFieldGroup.RANDOM_FIELD]: 'random_field',
  [GlobalFieldGroup.ROBOT_RANDOM_FIELD]: 'robot_random_field',
  [GlobalFieldGroup.MATERIAL_RANDOM_FIELD]: 'material_random_field',
  [GlobalFieldGroup.ANNOTATION_TYPE]: 'annotation_type',
  [GlobalFieldGroup.DELIVERY_FORMAT]: 'delivery_format',
  [GlobalFieldGroup.DELIVERY_LANGUAGE]: 'delivery_language',
  [GlobalFieldGroup.DELIVERY_METHOD]: 'delivery_method',
  [GlobalFieldGroup.SAMPLING_POLICY]: 'sampling_policy',
};

function sourceId(message: { sourceId?: string; name: string }): string {
  return message.sourceId || message.name.split('/').at(-1) || message.name;
}

function iso(value?: Timestamp): string {
  return value ? timestampDate(value).toISOString() : new Date(0).toISOString();
}

function hours(value?: { seconds: bigint; nanos: number }): number {
  return value ? Number(value.seconds) / 3600 + value.nanos / 3_600_000_000_000 : 0;
}

function date(value?: { year: number; month: number; day: number }): string {
  if (!value) return '';
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function legacyAttachment(name: string, byName: Map<string, CanonicalSnapshot['attachments'][number]>): RequirementAttachment | undefined {
  const item = byName.get(name);
  if (!item) return undefined;
  return {
    id: sourceId(item),
    name: item.filename,
    size: Number(item.sizeBytes),
    contentType: item.mediaType,
    storageKey: item.storageKey || '',
    uploadedAt: iso(item.createTime),
  };
}

function operationRules(items: Array<{ category?: string; description: string; note?: string }>) {
  return items.map((item) => ({ operation: item.description, note: item.note || '' }));
}

function taskVersion(
  revision: CanonicalSnapshot['taskSopRevisions'][number],
  snapshot: CanonicalSnapshot,
  attachments: Map<string, CanonicalSnapshot['attachments'][number]>,
): SubsceneVersion {
  const task = revision.snapshot!;
  const spec = task.spec!;
  const materialByName = new Map(snapshot.materials.map((item) => [item.name, item]));
  const objectDisplay = new Map(spec.objects.map((item) => [item.id, item.displayName]));
  const previous = revision.previousRevision
    ? snapshot.taskSopRevisions.find((item) => item.name === revision.previousRevision)
    : undefined;
  const location = (item: NonNullable<typeof spec.objectStates>['initial'][number]['allowedLocations'][number]) => ({
    location: item.displayName || '',
    referencePath: item.referencePath.map((relation) => ({
      level: relation.level,
      referenceObject: relation.referenceObject || (relation.objectId ? objectDisplay.get(relation.objectId) || relation.objectId : ''),
      relativePosition: relation.relativePosition || '',
    })),
    supportSurface: item.supportSurface || '',
    allowedRegions: [...item.regions],
    allowedPose: [...item.poses],
    allowedForm: [...item.forms],
    parameters: item.parameters.flatMap((parameter) => parameter.values),
    collectorInstruction: item.collectorInstruction,
    exampleImageAttachmentIds: item.exampleImages.map((name) => sourceId(attachments.get(name) ?? { name })),
    constraints: [...item.constraints],
  });
  const steps = (items: NonNullable<typeof spec.collection>['steps']) => items.map((step) => ({
    order: step.order,
    description: step.description,
    atomicSkill: step.atomicSkill,
    englishDescription: step.englishDescription,
    englishAtomicSkill: step.englishAtomicSkill,
  }));
  const policy = (items: NonNullable<NonNullable<typeof spec.collection>['policy']>['allowed']) => items.map((item) => ({ type: item.category, description: item.description }));
  return {
    version: revision.versionLabel,
    versionId: revision.sourceVersionId,
    parentVersionId: previous?.sourceVersionId,
    status: lifecycleMap[task.lifecycle] ?? 'draft',
    title: task.displayName,
    sceneName: task.legacySceneDisplayName,
    subsceneName: task.legacySubsceneDisplayName,
    description: task.description || '',
    attachments: task.attachments.flatMap((name) => legacyAttachment(name, attachments) ?? []),
    requiredDurationHours: hours(spec.expectedDuration),
    materials: spec.objects.map((object) => {
      const material = object.material ? materialByName.get(object.material) : undefined;
      const amount = object.quantity?.amount;
      return {
        materialId: material ? sourceId(material) : '',
        skuId: object.materialDescriptor?.sku || material?.sku || '',
        type: object.materialDescriptor?.category || material?.category || object.displayName,
        quantity: amount?.case === 'range'
          ? { mode: 'range' as const, min: amount.value.minValue, max: amount.value.maxValue, unit: object.quantity?.unit || '' }
          : { mode: 'fixed' as const, value: amount?.case === 'fixedValue' ? amount.value : 0, unit: object.quantity?.unit || '' },
        color: object.materialDescriptor?.color || material?.colors[0] || '',
        material: object.materialDescriptor?.composition || material?.compositions[0] || '',
        packageType: object.materialDescriptor?.packaging || material?.packaging || '',
      };
    }),
    robotState: { initial: spec.robotState?.initial || '', target: spec.robotState?.target || '' },
    robotOperationRequirements: spec.robotOperationRequirements,
    robotInitialRandomizationRequirements: [...spec.robotInitialRandomizationRequirements],
    randomizationFrequency: spec.legacyRandomizationFrequency,
    randomization: {
      robotInitialState: {
        enabled: spec.randomization?.robotInitialState?.enabled ?? false,
        changeFrequency: frequencyMap[spec.randomization?.robotInitialState?.change?.frequency ?? 0] ?? 'fixed',
        changeIntervalRecords: spec.randomization?.robotInitialState?.change?.intervalRecords,
        randomizedFields: (spec.randomization?.robotInitialState?.fields ?? []).map((field) => ({
          field: field.fieldId, displayName: field.displayName || field.fieldId, constraints: [...field.constraints],
        })),
      },
      materialInitialState: {
        rules: (spec.randomization?.objectInitialStates ?? []).map((rule) => ({
          targetMaterials: rule.objectIds.map((id) => objectDisplay.get(id) || ''),
          changeFrequency: frequencyMap[rule.change?.frequency ?? 0] ?? 'fixed',
          changeIntervalRecords: rule.change?.intervalRecords,
          randomizedFields: {
            locations: rule.locations.map((item) => ({ name: item.name, valueSource: item.valueSource })),
            poses: rule.poses.map((item) => ({ name: item.name, valueSource: item.valueSource })),
            forms: rule.forms.map((item) => ({ name: item.name, valueSource: item.valueSource })),
          },
          collectorInstruction: rule.collectorInstruction,
          exampleImageAttachmentIds: rule.exampleImages.map((name) => sourceId(attachments.get(name) ?? { name })),
          constraints: [...rule.constraints],
        })),
      },
      materialStateDuringOperation: {
        rules: (spec.randomization?.objectDuringOperation ?? []).map((rule) => ({
          targetMaterial: objectDisplay.get(rule.objectIds[0]) || '',
          changeFrequency: frequencyMap[rule.change?.frequency ?? 0] ?? 'fixed',
          changeIntervalRecords: rule.change?.intervalRecords,
          randomizedFields: { parameters: rule.parameterNames.map((name) => ({ name })) },
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
      allowedOperations: policy(spec.collection?.policy?.allowed ?? []),
      acceptableOperations: policy(spec.collection?.policy?.acceptable ?? []),
      forbiddenOperations: policy(spec.collection?.policy?.forbidden ?? []),
    },
    objectStates: {
      initial: (spec.objectStates?.initial ?? []).map((state) => ({
        object: objectDisplay.get(state.objectId) || '',
        allowedLocations: state.allowedLocations.map(location),
      })),
      target: (spec.objectStates?.target ?? []).map((state) => ({
        object: objectDisplay.get(state.objectId) || '',
        requiredLocation: state.requiredLocation?.displayName || '',
        requiredRegions: [...(state.requiredLocation?.regions ?? [])],
        requiredPose: [...(state.requiredLocation?.poses ?? [])],
        requiredForm: [...(state.requiredLocation?.forms ?? [])],
        referencePath: (state.requiredLocation?.referencePath ?? []).map((relation) => ({
          level: relation.level,
          referenceObject: relation.referenceObject || (relation.objectId ? objectDisplay.get(relation.objectId) || relation.objectId : ''),
          relativePosition: relation.relativePosition || '',
        })),
        supportSurface: state.requiredLocation?.supportSurface,
        parameters: state.requiredLocation?.parameters.flatMap((parameter) => parameter.values),
        collectorInstruction: state.requiredLocation?.collectorInstruction,
        exampleImageAttachmentIds: (state.requiredLocation?.exampleImages ?? []).map((name) => sourceId(attachments.get(name) ?? { name })),
        constraints: [...(state.requiredLocation?.constraints ?? [])],
      })),
      duringOperation: (spec.objectStates?.duringOperation ?? []).map((state) => ({
        object: objectDisplay.get(state.objectId) || '',
        parameters: state.parameters.map((parameter) => ({
          name: parameter.name, displayName: parameter.displayName, valueType: parameter.valueType,
          unit: parameter.unit, allowedValues: [...parameter.allowedValues],
          sampling: parameter.sampling?.value.case === 'range'
            ? { mode: 'range' as const, min: parameter.sampling.value.value.minValue, max: parameter.sampling.value.value.maxValue }
            : parameter.sampling?.value.case === 'fixedValue'
              ? { mode: 'fixed' as const, value: parameter.sampling.value.value }
              : undefined,
          constraints: [...parameter.constraints],
        })),
      })),
    },
    materialStateRules: spec.materialStateRules.map((rule) => ({
      id: sourceId(rule), materialType: rule.materialType, primaryReferences: [...rule.primaryReferences],
      primaryRelativePositions: [...rule.primaryRelativePositions], supportSurfaces: [...rule.supportSurfaces], regions: [...rule.regions],
      secondaryReferences: [...rule.secondaryReferences], secondaryRelativePositions: [...rule.secondaryRelativePositions],
      poses: [...rule.poses], forms: [...rule.forms], parameters: [...rule.parameters], updatedAt: iso(rule.updateTime),
    })),
    annotation: {
      status: spec.annotation?.readiness === AnnotationReadiness.READY ? 'ready'
        : spec.annotation?.readiness === AnnotationReadiness.NOT_REQUIRED ? 'not_required' : 'pending',
      note: spec.annotation?.note || '', actionTags: [...(spec.annotation?.actionTags ?? [])], steps: steps(spec.annotation?.steps ?? []),
      allowedOperations: policy(spec.annotation?.policy?.allowed ?? []), forbiddenOperations: policy(spec.annotation?.policy?.forbidden ?? []),
      stepRandomization: spec.annotation?.stepRandomization ? {
        enabled: spec.annotation.stepRandomization.enabled,
        startOrder: spec.annotation.stepRandomization.startStepNumber || 1,
        endOrder: spec.annotation.stepRandomization.endStepNumber || 1,
      } : undefined,
    },
    references: {
      recordUrls: [...task.referenceUris],
      attachments: task.referenceAttachments.map((item) => ({ fileToken: item.fileToken, name: item.filename, size: Number(item.sizeBytes) })),
    },
    updatedAt: iso(task.updateTime ?? revision.createTime),
  };
}

function requirementVersion(
  revision: CanonicalSnapshot['requirementRevisions'][number],
  snapshot: CanonicalSnapshot,
  attachments: Map<string, CanonicalSnapshot['attachments'][number]>,
): RequirementVersion {
  const requirement = revision.snapshot!;
  const spec = requirement.spec!;
  const previous = revision.previousRevision
    ? snapshot.requirementRevisions.find((item) => item.name === revision.previousRevision)
    : undefined;
  const customer = snapshot.customers.find((item) => item.name === spec.customer);
  const robotRevision = snapshot.robotModelRevisions.find((item) => item.name === spec.robotModelRevision);
  const rules = (items: Array<{ description: string; note?: string }>) => operationRules(items);
  const groupedForbidden = new Map<string, Array<{ operation: string; note: string }>>();
  for (const item of spec.globalRequirements?.collectionPolicy?.forbidden ?? []) {
    const category = item.category || '';
    groupedForbidden.set(category, [...(groupedForbidden.get(category) ?? []), { operation: item.description, note: item.note || '' }]);
  }
  return {
    version: revision.versionLabel,
    versionId: revision.sourceVersionId,
    parentVersionId: previous?.sourceVersionId,
    status: lifecycleMap[requirement.lifecycle] ?? 'draft',
    title: requirement.displayName,
    projectName: spec.projectDisplayName || '',
    priority: priorityMap[spec.priority] ?? 'P2',
    deadline: date(spec.deadline),
    sourceBaseUrl: spec.sourceUri,
    attachmentNotes: spec.attachmentNotes,
    attachments: requirement.attachments.flatMap((name) => legacyAttachment(name, attachments) ?? []),
    extraTopicRequirementsText: spec.extraTopicRequirementsText,
    globalRandomizationRequirements: spec.globalRequirements?.randomizationNotes || '',
    additionalNotes: spec.globalRequirements?.additionalNotes || '',
    customerId: customer ? sourceId(customer) : '',
    robotModelId: robotRevision?.snapshot ? sourceId(robotRevision.snapshot) : '',
    businessGoal: spec.businessGoal,
    requestedScenes: [...spec.requestedSceneNames],
    requiredDurationHours: hours(spec.aggregateTarget?.duration),
    allowedOperations: rules(spec.globalRequirements?.collectionPolicy?.allowed ?? []),
    acceptableOperations: rules(spec.globalRequirements?.collectionPolicy?.acceptable ?? []),
    forbiddenOperations: [...groupedForbidden].map(([category, operations]) => ({ category, operations })),
    annotation: {
      required: spec.annotation?.required ?? true,
      types: [...(spec.annotation?.types ?? [])],
      allowedOperations: rules(spec.globalRequirements?.annotationPolicy?.allowed ?? []),
      forbiddenOperations: rules(spec.globalRequirements?.annotationPolicy?.forbidden ?? []),
    },
    qualityInspection: {
      required: spec.qualityInspection?.required ?? true,
      samplingPolicy: spec.qualityInspection?.samplingPolicy || '',
    },
    delivery: {
      formats: [...(spec.delivery?.formats ?? [])], method: spec.delivery?.method || '',
      languages: (spec.delivery?.languages ?? []).map((item) => ({ code: item.code, name: item.displayName || '' })),
      dataStructureUrl: spec.delivery?.dataStructureUri || '',
    },
    selectedSubscenes: spec.productionItems.map((item) => {
      const taskRevision = snapshot.taskSopRevisions.find((candidate) => candidate.name === item.taskSopRevision);
      const task = taskRevision?.snapshot;
      return {
        id: item.id, title: item.displayName, description: item.description,
        subsceneCode: item.legacySubsceneCode || task?.legacySubsceneCode,
        subsceneName: item.legacySubsceneName || task?.legacySubsceneDisplayName,
        sceneName: item.legacySceneName || task?.legacySceneDisplayName || '',
        version: taskRevision?.versionLabel || item.legacyVersionLabel,
        targetDurationHours: hours(item.target?.duration),
        targetCollectionCount: item.target?.collectionCount ? Number(item.target.collectionCount) : 0,
        taskSop: taskRevision ? {
          sceneName: item.legacySceneName || task?.legacySceneDisplayName || '',
          title: task?.displayName || item.displayName,
          version: taskRevision.versionLabel,
          versionId: taskRevision.sourceVersionId,
          parentVersionId: taskRevision.previousRevision
            ? snapshot.taskSopRevisions.find((candidate) => candidate.name === taskRevision.previousRevision)?.sourceVersionId
            : undefined,
          status: task ? lifecycleMap[task.lifecycle] : undefined,
        } : undefined,
      };
    }),
    updatedAt: iso(requirement.updateTime ?? revision.createTime),
  };
}

function revisionCatalog(
  snapshot: CanonicalSnapshot,
  lifecycle: Lifecycle,
  frozen?: CanonicalSnapshot['taskSopRevisions'][number]['frozenDependencies'],
): CanonicalSnapshot {
  if (lifecycle === Lifecycle.DRAFT || !frozen) return snapshot;
  return {
    ...snapshot,
    customers: frozen.customers,
    materials: frozen.materials,
    scenes: frozen.scenes,
    globalFields: frozen.globalFields,
    materialStateRules: frozen.materialStateRules,
    attachments: frozen.attachments,
  };
}

export function projectCanonicalToRest(snapshot: CanonicalSnapshot): AppData {
  const attachments = new Map(snapshot.attachments.map((item) => [item.name, item]));
  const taskRevisionsByScene = new Map<string, CanonicalSnapshot['taskSopRevisions']>();
  for (const revision of snapshot.taskSopRevisions) {
    const scene = revision.snapshot?.scene;
    if (scene) taskRevisionsByScene.set(scene, [...(taskRevisionsByScene.get(scene) ?? []), revision]);
  }
  return {
    metadata: defaultAppMetadata,
    customers: snapshot.customers.map((item) => ({
      id: sourceId(item), name: item.displayName,
      contact: { name: item.primaryContact?.displayName || '', phone: item.primaryContact?.phone || '', email: item.primaryContact?.email || '' },
      notes: item.notes,
    })),
    materials: snapshot.materials.map((item) => ({
      id: sourceId(item), skuId: item.sku || '', type: item.category || item.displayName, color: item.colors[0] || '',
      material: item.compositions[0] || '', packageType: item.packaging || '', size: item.size, weight: item.weight,
      images: item.images.flatMap((name) => legacyAttachment(name, attachments) ?? []),
    })),
    robotModels: snapshot.robotModels.map((item) => ({
      id: sourceId(item), brand: item.manufacturer || '', model: item.modelCode || '', terminal: item.endEffector || '',
      topics: Object.fromEntries(item.topics.map((topic) => [topic.id, topic.topic])),
      extraTopicRequirements: Object.fromEntries(item.extraTopicRequirements.map((topic) => [topic.topicId, topic.requirement])),
    })),
    scenes: snapshot.scenes.map((scene) => {
      const tasks = new Map<string, CanonicalSnapshot['taskSopRevisions']>();
      for (const revision of taskRevisionsByScene.get(scene.name) ?? []) {
        const code = revision.snapshot?.legacySubsceneCode || revision.snapshot?.name.split('/').at(-1) || '';
        tasks.set(code, [...(tasks.get(code) ?? []), revision]);
      }
      return {
        id: sourceId(scene), name: scene.displayName, description: scene.description || '',
        subscenes: [...tasks].map(([code, revisions]) => ({
          code,
          name: revisions.at(-1)?.snapshot?.legacySubsceneDisplayName || revisions.at(-1)?.snapshot?.displayName || code,
          versions: revisions
            .slice()
            .sort((left, right) => left.versionLabel.localeCompare(right.versionLabel, undefined, { numeric: true }))
            .map((revision) => {
              const effective = revisionCatalog(snapshot, revision.snapshot?.lifecycle ?? Lifecycle.DRAFT, revision.frozenDependencies);
              return taskVersion(revision, effective, new Map(effective.attachments.map((item) => [item.name, item])));
            }),
        })),
      };
    }),
    requirements: snapshot.requirements.map((item) => ({
      id: sourceId(item),
      versions: snapshot.requirementRevisions
        .filter((revision) => revision.snapshot?.name === item.name)
        .slice()
        .sort((left, right) => left.versionLabel.localeCompare(right.versionLabel, undefined, { numeric: true }))
        .map((revision) => {
          const effective = revisionCatalog(snapshot, revision.snapshot?.lifecycle ?? Lifecycle.DRAFT, revision.frozenDependencies);
          return requirementVersion(revision, effective, new Map(effective.attachments.map((attachment) => [attachment.name, attachment])));
        }),
    })),
    globalFields: snapshot.globalFields.map((item) => ({
      id: sourceId(item), group: fieldGroupMap[item.group], label: item.label, value: item.value,
      category: item.category, description: item.description,
      status: item.status === GlobalFieldStatus.INACTIVE ? 'inactive' : 'active', updatedAt: iso(item.updateTime),
    })),
    materialStateRules: snapshot.materialStateRules.map((item) => ({
      id: sourceId(item), materialType: item.materialType, primaryReferences: [...item.primaryReferences],
      primaryRelativePositions: [...item.primaryRelativePositions], supportSurfaces: [...item.supportSurfaces], regions: [...item.regions],
      secondaryReferences: [...item.secondaryReferences], secondaryRelativePositions: [...item.secondaryRelativePositions],
      poses: [...item.poses], forms: [...item.forms], parameters: [...item.parameters], updatedAt: iso(item.updateTime),
    })),
  };
}
