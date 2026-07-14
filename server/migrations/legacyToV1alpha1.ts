import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
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
  type Attachment,
} from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import {
  AnnotationReadiness,
  ChangeFrequency,
  GlobalFieldGroup,
  GlobalFieldStatus,
  Lifecycle,
  Priority,
} from '../../gen/coscene/sop/v1alpha1/common_pb';
import { RequirementRevisionSchema, RequirementSchema } from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import { TaskSopRevisionSchema, TaskSopSchema } from '../../gen/coscene/sop/v1alpha1/task_sop_pb';
import type {
  AppData,
  ChangeFrequency as LegacyChangeFrequency,
  EntityStatus,
  GlobalFieldGroup as LegacyGlobalFieldGroup,
  Priority as LegacyPriority,
  RequirementAttachment,
  RequirementVersion,
  SubsceneVersion,
  TextItem,
} from '../../shared/transport/restDto';
import { canonicalSchemaVersion, emptyCanonicalSnapshot, type CanonicalSnapshot } from '../domain/appStore';
import { canonicalCardinalities, canonicalSemanticDigest, fingerprintRecord } from './semanticProjection';
import {
  IdentityRegistry,
  canonicalId,
  deterministicUid,
  resourceName,
  revisionName,
  stableHash,
  stableJson,
} from './identity';
import { finalizeReport, type MigrationIssue, type MigrationReport } from './report';

export type LegacyConversion = { snapshot: CanonicalSnapshot; report: MigrationReport };

const excludedLegacyPaths = [
  'metadata.requirementYamlSchemaVersion (legacy export boundary)',
  'metadata.taskSopYamlSchemaVersion (legacy export boundary)',
];

const documentedNormalizations = [
  'selectedSubscenes[].targetDurationHours=0 is legacy unset and maps to absent WorkloadTarget.duration',
  'requiredDurationHours=-1 is the legacy unset sentinel and maps to absent duration',
  'operation policy rows with every persisted scalar empty are unsaved UI placeholders and are omitted',
];

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

export function decodeLegacyAppData(value: unknown): AppData {
  const record = requireRecord(value, '$');
  const arrays = ['customers', 'materials', 'robotModels', 'scenes', 'requirements', 'globalFields', 'materialStateRules'] as const;
  requireRecord(record.metadata, '$.metadata');
  for (const key of arrays) if (!Array.isArray(record[key])) throw new TypeError(`$.${key} must be an array`);
  return structuredClone(value) as AppData;
}

function timestamp(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : timestampFromDate(date);
}

function lifecycle(value: EntityStatus): Lifecycle {
  return { draft: Lifecycle.DRAFT, confirmed: Lifecycle.CONFIRMED, archived: Lifecycle.ARCHIVED }[value];
}

function priority(value: LegacyPriority): Priority {
  return { P0: Priority.P0, P1: Priority.P1, P2: Priority.P2, P3: Priority.P3 }[value];
}

function changeFrequency(value: LegacyChangeFrequency): ChangeFrequency {
  return {
    every_record: ChangeFrequency.EVERY_RECORD,
    every_n_records: ChangeFrequency.EVERY_N_RECORDS,
    per_batch: ChangeFrequency.PER_BATCH,
    fixed: ChangeFrequency.FIXED,
  }[value];
}

const globalFieldGroup = Object.fromEntries([
  'robot_state', 'reference_object', 'relative_position', 'support_surface', 'region', 'pose', 'form', 'parameter',
  'allowed_operation', 'acceptable_operation', 'forbidden_operation', 'annotation_allowed_operation',
  'annotation_forbidden_operation', 'random_field', 'robot_random_field', 'material_random_field', 'annotation_type',
  'delivery_format', 'delivery_language', 'delivery_method', 'sampling_policy',
].map((key, index) => [key, index + 1])) as Record<LegacyGlobalFieldGroup, GlobalFieldGroup>;

function durationHours(hours?: number) {
  if (hours === undefined || hours <= 0) return undefined;
  const totalSeconds = hours * 3600;
  let seconds = Math.floor(totalSeconds);
  let nanos = Math.round((totalSeconds - seconds) * 1_000_000_000);
  if (nanos === 1_000_000_000) {
    seconds += 1;
    nanos = 0;
  }
  return { seconds: BigInt(seconds), nanos };
}

function dateValue(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? { year, month, day } : undefined;
}

function optional(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function operationRules(items: TextItem[] | undefined, prefix: string) {
  return (items ?? []).flatMap((item, index) => item.description !== '' || (item.type ?? '') !== '' ? [{
    id: canonicalId(`${prefix}-${index + 1}`, `${prefix}:${index}`),
    description: item.description,
    category: optional(item.type),
  }] : []);
}

function requirementRules(items: Array<{ operation: string; note: string }> | undefined, prefix: string, category?: string) {
  return (items ?? []).flatMap((item, index) => item.operation !== '' || item.note !== '' || (category ?? '') !== '' ? [{
    id: canonicalId(`${prefix}-${index + 1}`, `${prefix}:${index}`),
    description: item.operation,
    category: optional(category),
    note: optional(item.note),
  }] : []);
}

function collectResourceReferences(value: unknown, prefix: string, result = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (value.startsWith(prefix)) result.add(value);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResourceReferences(item, prefix, result);
    return result;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectResourceReferences(item, prefix, result);
  }
  return result;
}

type VocabularyReference = { group: LegacyGlobalFieldGroup; value: string; path: string };

function taskVocabularyReferences(version: SubsceneVersion): VocabularyReference[] {
  const refs: VocabularyReference[] = [];
  const add = (group: LegacyGlobalFieldGroup, values: Array<string | undefined>, path: string) => {
    values.forEach((value, index) => { if (value) refs.push({ group, value, path: `${path}[${index}]` }); });
  };
  add('robot_state', [version.robotState.initial, version.robotState.target], 'robotState');
  const locations = [
    ...version.objectStates.initial.flatMap((state) => state.allowedLocations),
    ...version.objectStates.target.map((state) => ({
      referencePath: state.referencePath ?? [], supportSurface: state.supportSurface,
      allowedRegions: state.requiredRegions, allowedPose: state.requiredPose, allowedForm: state.requiredForm,
      parameters: state.parameters ?? [],
    })),
  ];
  locations.forEach((location, index) => {
    add('reference_object', location.referencePath.map((item) => item.referenceObject), `objectStates.locations[${index}].referencePath.referenceObject`);
    add('relative_position', location.referencePath.map((item) => item.relativePosition), `objectStates.locations[${index}].referencePath.relativePosition`);
    add('support_surface', [location.supportSurface], `objectStates.locations[${index}].supportSurface`);
    add('region', location.allowedRegions, `objectStates.locations[${index}].regions`);
    add('pose', location.allowedPose, `objectStates.locations[${index}].poses`);
    add('form', location.allowedForm, `objectStates.locations[${index}].forms`);
    add('parameter', location.parameters ?? [], `objectStates.locations[${index}].parameters`);
  });
  add('parameter', (version.objectStates.duringOperation ?? []).flatMap((state) => state.parameters.map((item) => item.name)), 'objectStates.duringOperation.parameters');
  add('robot_random_field', version.randomization.robotInitialState.randomizedFields.map((item) => item.field), 'randomization.robotInitialState.fields');
  add('material_random_field', (version.randomization.materialInitialState.rules ?? []).flatMap((rule) => [
    ...rule.randomizedFields.locations.flatMap((item) => [item.name, item.valueSource]),
    ...rule.randomizedFields.poses.flatMap((item) => [item.name, item.valueSource]),
    ...rule.randomizedFields.forms.flatMap((item) => [item.name, item.valueSource]),
  ]), 'randomization.materialInitialState.fields');
  add('material_random_field', (version.randomization.materialStateDuringOperation?.rules ?? []).flatMap((rule) => rule.randomizedFields.parameters.map((item) => item.name)), 'randomization.materialStateDuringOperation.fields');
  add('allowed_operation', version.operation.allowedOperations.map((item) => item.description), 'operation.allowed');
  add('acceptable_operation', (version.operation.acceptableOperations ?? []).map((item) => item.description), 'operation.acceptable');
  add('forbidden_operation', version.operation.forbiddenOperations.map((item) => item.description), 'operation.forbidden');
  add('annotation_allowed_operation', (version.annotation.allowedOperations ?? []).map((item) => item.description), 'annotation.allowed');
  add('annotation_forbidden_operation', (version.annotation.forbiddenOperations ?? []).map((item) => item.description), 'annotation.forbidden');
  add('annotation_type', version.annotation.actionTags, 'annotation.actionTags');
  for (const [index, rule] of (version.materialStateRules ?? []).entries()) {
    add('reference_object', [...rule.primaryReferences, ...rule.secondaryReferences], `materialStateRules[${index}].references`);
    add('relative_position', [...rule.primaryRelativePositions, ...rule.secondaryRelativePositions], `materialStateRules[${index}].relativePositions`);
    add('support_surface', rule.supportSurfaces, `materialStateRules[${index}].supportSurfaces`);
    add('region', rule.regions, `materialStateRules[${index}].regions`);
    add('pose', rule.poses, `materialStateRules[${index}].poses`);
    add('form', rule.forms, `materialStateRules[${index}].forms`);
    add('parameter', rule.parameters, `materialStateRules[${index}].parameters`);
  }
  return refs;
}

function requirementVocabularyReferences(version: RequirementVersion): VocabularyReference[] {
  const refs: VocabularyReference[] = [];
  const add = (group: LegacyGlobalFieldGroup, values: Array<string | undefined>, path: string) => {
    values.forEach((value, index) => { if (value) refs.push({ group, value, path: `${path}[${index}]` }); });
  };
  add('allowed_operation', version.allowedOperations.map((item) => item.operation), 'allowedOperations');
  add('acceptable_operation', (version.acceptableOperations ?? []).map((item) => item.operation), 'acceptableOperations');
  add('forbidden_operation', version.forbiddenOperations.flatMap((group) => group.operations.map((item) => item.operation)), 'forbiddenOperations');
  add('annotation_allowed_operation', (version.annotation.allowedOperations ?? []).map((item) => item.operation), 'annotation.allowedOperations');
  add('annotation_forbidden_operation', (version.annotation.forbiddenOperations ?? []).map((item) => item.operation), 'annotation.forbiddenOperations');
  add('annotation_type', version.annotation.types, 'annotation.types');
  add('sampling_policy', [version.qualityInspection.samplingPolicy], 'qualityInspection.samplingPolicy');
  add('delivery_format', version.delivery.formats, 'delivery.formats');
  add('delivery_method', [version.delivery.method], 'delivery.method');
  add('delivery_language', version.delivery.languages.flatMap((item) => [item.code, item.name]), 'delivery.languages');
  return refs;
}

function selectFrozenGlobalFields(
  refs: VocabularyReference[],
  fields: CanonicalSnapshot['globalFields'],
  issues: MigrationIssue[],
  owner: string,
): CanonicalSnapshot['globalFields'] {
  const selected = new Set<string>();
  const reported = new Set<string>();
  for (const ref of refs) {
    const sameGroup = fields.filter((field) => field.group === globalFieldGroup[ref.group]);
    const identifierMatches = sameGroup.filter((field) => field.name === ref.value || field.sourceId === ref.value);
    const candidates = identifierMatches.length
      ? identifierMatches
      : sameGroup.filter((field) => field.value === ref.value || field.label === ref.value);
    if (candidates.length === 1) selected.add(candidates[0].name);
    if (candidates.length > 1) {
      const key = `${ref.group}:${ref.value}`;
      if (!reported.has(key)) {
        reported.add(key);
        issues.push({
          code: 'AMBIGUOUS_REFERENCE', owner, path: ref.path,
          message: `global field reference is ambiguous in ${ref.group}: ${ref.value}`,
          candidates: candidates.map((field) => field.name),
        });
      }
    }
  }
  return fields.filter((field) => selected.has(field.name));
}

function attachmentMessage(item: RequirementAttachment): Attachment {
  const name = resourceName('attachments', item.id);
  return create(AttachmentSchema, {
    name,
    uid: deterministicUid('attachment', item.id),
    filename: item.name,
    mediaType: item.contentType || 'application/octet-stream',
    sizeBytes: BigInt(item.size),
    storageKey: optional(item.storageKey),
    createTime: timestamp(item.uploadedAt),
    sourceId: item.id,
  });
}

function collectAttachments(data: AppData, issues: MigrationIssue[]): Map<string, Attachment> {
  const result = new Map<string, Attachment>();
  const add = (item: RequirementAttachment, owner: string) => {
    if (!Number.isSafeInteger(item.size) || item.size < 0) issues.push({ code: 'INVALID_LEGACY_DATA', owner, path: `attachments.${item.id}.size`, message: `attachment size must be a non-negative safe integer: ${item.size}` });
    if (!item.storageKey) issues.push({ code: 'INVALID_LEGACY_DATA', owner, path: `attachments.${item.id}.storageKey`, message: 'managed attachment storageKey is required' });
    const canonical = attachmentMessage(item);
    const existing = result.get(item.id);
    if (existing && stableJson(existing) !== stableJson(canonical)) {
      issues.push({ code: 'COLLISION', owner, path: `attachments.${item.id}`, message: 'attachment ID has conflicting metadata' });
      return;
    }
    result.set(item.id, canonical);
  };
  for (const material of data.materials) for (const item of material.images ?? []) add(item, `material:${material.id}`);
  for (const scene of data.scenes) for (const subscene of scene.subscenes) for (const version of subscene.versions) {
    for (const item of version.attachments ?? []) add(item, `task:${scene.id}/${subscene.code}/${version.version}`);
  }
  for (const requirement of data.requirements) for (const version of requirement.versions) {
    for (const item of version.attachments ?? []) add(item, `requirement:${requirement.id}/${version.version}`);
  }
  return result;
}

function toTaskSpec(version: SubsceneVersion, materialNames: Map<string, string>, attachmentNames: Map<string, string>, issues: MigrationIssue[], owner: string) {
  const objectAliases = new Map<string, string[]>();
  const objects = version.materials.map((item, index) => {
    const id = canonicalId(item.materialId || item.type || `object-${index + 1}`, `${owner}:object:${index}`);
    for (const alias of [item.materialId, item.type]) {
      if (alias) objectAliases.set(alias, [...(objectAliases.get(alias) ?? []), id]);
    }
    const material = materialNames.get(item.materialId);
    if (item.materialId && !material) issues.push({ code: 'UNRESOLVED_REFERENCE', owner, path: `materials[${index}].materialId`, message: `material not found: ${item.materialId}` });
    return {
      id,
      displayName: item.type || item.skuId || id,
      material,
      quantity: {
        amount: item.quantity.mode === 'range'
          ? { case: 'range' as const, value: { minValue: item.quantity.min ?? 0, maxValue: item.quantity.max ?? 0 } }
          : { case: 'fixedValue' as const, value: item.quantity.value ?? 0 },
        unit: item.quantity.unit || 'unit',
      },
      materialDescriptor: {
        sku: optional(item.skuId), category: optional(item.type), color: optional(item.color),
        composition: optional(item.material), packaging: optional(item.packageType),
      },
    };
  });
  const objectId = (alias: string, path: string) => {
    // Empty selections are valid while editing a draft. The canonical schema
    // still requires an object identifier, so keep a deterministic placeholder
    // without treating the unfinished field as a dangling reference. Projection
    // maps placeholders that do not belong to the task object set back to "".
    if (!alias) return canonicalId('draft-object', `${owner}:${path}:empty`);
    const candidates = objectAliases.get(alias) ?? [];
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) issues.push({ code: 'AMBIGUOUS_REFERENCE', owner, path, message: `object alias is ambiguous: ${alias}`, candidates });
    else issues.push({ code: 'UNRESOLVED_REFERENCE', owner, path, message: `object alias not found: ${alias}` });
    return canonicalId(alias, `${owner}:${path}:${alias}`);
  };
  const referenceObjectId = (alias: string, path: string) => {
    const candidates = objectAliases.get(alias) ?? [];
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) issues.push({ code: 'AMBIGUOUS_REFERENCE', owner, path, message: `reference object alias is ambiguous: ${alias}`, candidates });
    return undefined;
  };
  const imageNames = (ids: string[] | undefined, path: string) => (ids ?? []).flatMap((id) => {
    if (!id) return [];
    const name = attachmentNames.get(id);
    if (!name) issues.push({ code: 'UNRESOLVED_REFERENCE', owner, path, message: `attachment not found: ${id}` });
    return name ? [name] : [];
  });
  const location = (item: NonNullable<SubsceneVersion['objectStates']['initial'][number]['allowedLocations']>[number], path: string) => ({
    displayName: optional(item.location),
    referencePath: item.referencePath.map((reference) => ({
      objectId: referenceObjectId(reference.referenceObject, `${path}.referenceObject`),
      referenceObject: reference.referenceObject,
      relativePosition: reference.relativePosition,
      level: reference.level,
    })),
    supportSurface: optional(item.supportSurface), regions: item.allowedRegions, poses: item.allowedPose, forms: item.allowedForm,
    parameters: (item.parameters ?? []).map((value, index) => ({ key: `value-${index + 1}`, values: [value] })),
    collectorInstruction: optional(item.collectorInstruction), exampleImages: imageNames(item.exampleImageAttachmentIds, `${path}.exampleImageAttachmentIds`),
    constraints: item.constraints,
  });
  const operationSteps = (steps: SubsceneVersion['operation']['steps'] | undefined, prefix: string) => (steps ?? []).map((step, index) => ({
    id: canonicalId(`${prefix}-${step.order || index + 1}`, `${owner}:${prefix}:${index}`), order: step.order,
    description: step.description, atomicSkill: optional(step.atomicSkill), englishDescription: optional(step.englishDescription),
    englishAtomicSkill: optional(step.englishAtomicSkill),
  }));
  const randomizationFields = (rule: SubsceneVersion['randomization']['materialInitialState']['rules'][number], index: number) => {
    const sources = [
      ...rule.randomizedFields.locations.map((item) => ({ ...item, kind: 'location' })),
      ...rule.randomizedFields.poses.map((item) => ({ ...item, kind: 'pose' })),
      ...rule.randomizedFields.forms.map((item) => ({ ...item, kind: 'form' })),
    ];
    return sources.map((item) => ({
      fieldId: canonicalId(item.name, `${owner}:randomization:${index}:${item.name}`), displayName: item.name,
      constraints: item.valueSource ? [`value_source=${item.valueSource}`] : [],
    }));
  };
  return {
    objects,
    robotState: version.robotState,
    objectStates: {
      initial: version.objectStates.initial.map((state, index) => ({ objectId: objectId(state.object, `objectStates.initial[${index}].object`), allowedLocations: state.allowedLocations.map((item, locationIndex) => location(item, `objectStates.initial[${index}].allowedLocations[${locationIndex}]`)) })),
      target: version.objectStates.target.map((state, index) => ({ objectId: objectId(state.object, `objectStates.target[${index}].object`), requiredLocation: {
        displayName: optional(state.requiredLocation), referencePath: (state.referencePath ?? []).map((reference) => ({ objectId: referenceObjectId(reference.referenceObject, `objectStates.target[${index}].referenceObject`), referenceObject: reference.referenceObject, relativePosition: reference.relativePosition, level: reference.level })),
        supportSurface: optional(state.supportSurface), regions: state.requiredRegions, poses: state.requiredPose, forms: state.requiredForm,
        parameters: (state.parameters ?? []).map((value, parameterIndex) => ({ key: `value-${parameterIndex + 1}`, values: [value] })),
        collectorInstruction: optional(state.collectorInstruction), exampleImages: imageNames(state.exampleImageAttachmentIds, `objectStates.target[${index}].exampleImageAttachmentIds`), constraints: state.constraints ?? [],
      } })),
      duringOperation: (version.objectStates.duringOperation ?? []).map((state, index) => ({
        objectId: objectId(state.object, `objectStates.duringOperation[${index}].object`),
        parameters: state.parameters.map((parameter) => ({
          name: parameter.name,
          displayName: parameter.displayName,
          valueType: parameter.valueType,
          unit: optional(parameter.unit),
          allowedValues: parameter.allowedValues ?? [],
          sampling: parameter.sampling ? {
            value: parameter.sampling.mode === 'range'
              ? { case: 'range' as const, value: { minValue: parameter.sampling.min ?? 0, maxValue: parameter.sampling.max ?? 0 } }
              : { case: 'fixedValue' as const, value: parameter.sampling.value ?? 0 },
          } : undefined,
          constraints: parameter.constraints,
        })),
      })),
    },
    randomization: {
      robotInitialState: {
        enabled: version.randomization.robotInitialState.enabled,
        change: version.randomization.robotInitialState.enabled ? { frequency: changeFrequency(version.randomization.robotInitialState.changeFrequency), intervalRecords: version.randomization.robotInitialState.changeIntervalRecords } : undefined,
        fields: version.randomization.robotInitialState.randomizedFields.map((field) => ({ fieldId: canonicalId(field.field, `${owner}:field:${field.field}`), displayName: optional(field.displayName), constraints: field.constraints })),
      },
      objectInitialStates: version.randomization.materialInitialState.rules.map((rule, index) => ({
        objectIds: rule.targetMaterials.map((alias, aliasIndex) => objectId(alias, `randomization.materialInitialState.rules[${index}].targetMaterials[${aliasIndex}]`)),
        change: { frequency: changeFrequency(rule.changeFrequency), intervalRecords: rule.changeIntervalRecords }, fields: randomizationFields(rule, index),
        collectorInstruction: optional(rule.collectorInstruction), constraints: rule.constraints,
        exampleImages: imageNames(rule.exampleImageAttachmentIds, `randomization.materialInitialState.rules[${index}].exampleImageAttachmentIds`),
        locations: rule.randomizedFields.locations, poses: rule.randomizedFields.poses, forms: rule.randomizedFields.forms,
      })),
      objectDuringOperation: (version.randomization.materialStateDuringOperation?.rules ?? []).map((rule, index) => ({
        objectIds: [objectId(rule.targetMaterial, `randomization.materialStateDuringOperation.rules[${index}].targetMaterial`)],
        change: { frequency: changeFrequency(rule.changeFrequency), intervalRecords: rule.changeIntervalRecords },
        parameterNames: rule.randomizedFields.parameters.map((parameter) => parameter.name),
      })),
    },
    collection: {
      stepOrder: optional(version.operation.stepOrder), steps: operationSteps(version.operation.steps, 'step'),
      policy: { allowed: operationRules(version.operation.allowedOperations, 'allowed'), acceptable: operationRules(version.operation.acceptableOperations, 'acceptable'), forbidden: operationRules(version.operation.forbiddenOperations, 'forbidden') },
      stepRandomization: version.operation.stepRandomization ? version.operation.stepRandomization.enabled
        ? { enabled: true, startStepNumber: version.operation.stepRandomization.startOrder, endStepNumber: version.operation.stepRandomization.endOrder }
        : { enabled: false } : undefined,
    },
    annotation: {
      readiness: { pending: AnnotationReadiness.PENDING, ready: AnnotationReadiness.READY, not_required: AnnotationReadiness.NOT_REQUIRED }[version.annotation.status],
      note: optional(version.annotation.note), actionTags: version.annotation.actionTags, steps: operationSteps(version.annotation.steps, 'annotation-step'),
      policy: { allowed: operationRules(version.annotation.allowedOperations, 'annotation-allowed'), forbidden: operationRules(version.annotation.forbiddenOperations, 'annotation-forbidden') },
      stepRandomization: version.annotation.stepRandomization ? version.annotation.stepRandomization.enabled
        ? { enabled: true, startStepNumber: version.annotation.stepRandomization.startOrder, endStepNumber: version.annotation.stepRandomization.endOrder }
        : { enabled: false } : undefined,
    },
    expectedDuration: durationHours(version.requiredDurationHours), robotOperationRequirements: optional(version.robotOperationRequirements),
    robotInitialRandomizationRequirements: version.robotInitialRandomizationRequirements ?? [], legacyRandomizationFrequency: optional(version.randomizationFrequency),
    materialStateRules: (version.materialStateRules ?? []).map((rule) => ({
      name: resourceName('materialStateRules', rule.id), uid: deterministicUid('materialStateRule', rule.id), sourceId: rule.id,
      materialType: rule.materialType, primaryReferences: rule.primaryReferences, primaryRelativePositions: rule.primaryRelativePositions,
      supportSurfaces: rule.supportSurfaces, regions: rule.regions, secondaryReferences: rule.secondaryReferences,
      secondaryRelativePositions: rule.secondaryRelativePositions, poses: rule.poses, forms: rule.forms, parameters: rule.parameters,
      updateTime: timestamp(rule.updatedAt),
    })),
  };
}

export function convertLegacyToV1alpha1(input: unknown, sourceFingerprint = stableHash(stableJson(input))): LegacyConversion {
  const data = decodeLegacyAppData(input);
  const snapshot = emptyCanonicalSnapshot();
  const issues: MigrationIssue[] = [];
  const registry = new IdentityRegistry();
  const recordFingerprints: Record<string, string> = {};
  const register = (canonical: string, owner: string, aliases: string[] = []) => registry.register(canonical, owner, aliases);
  const stableCompare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const reportDuplicates = <T>(items: T[], identity: (item: T) => string, kind: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      const value = identity(item);
      if (seen.has(value)) issues.push({ code: 'COLLISION', owner: `${kind}:${value}`, path: value, message: `duplicate legacy ${kind} identity` });
      seen.add(value);
    }
  };
  reportDuplicates(data.customers, (item) => item.id, 'customer');
  reportDuplicates(data.materials, (item) => item.id, 'material');
  reportDuplicates(data.robotModels, (item) => item.id, 'robotModel');
  reportDuplicates(data.scenes, (item) => item.id, 'scene');
  reportDuplicates(data.globalFields, (item) => item.id, 'globalField');
  reportDuplicates(data.materialStateRules, (item) => item.id, 'materialStateRule');
  reportDuplicates(data.requirements, (item) => item.id, 'requirement');
  const legacyTasks = data.scenes.flatMap((scene) => scene.subscenes.map((subscene) => ({ scene, subscene })));
  reportDuplicates(legacyTasks, (item) => `${item.scene.id}/${item.subscene.code}`, 'taskSop');
  for (const { scene, subscene } of legacyTasks) reportDuplicates(subscene.versions, (version) => revisionName(resourceName('taskSops', `${scene.id}-${subscene.code}`), version.version, version.versionId), 'taskSopRevision');
  const validTimestamp = (value: string | undefined, owner: string, path: string) => {
    if (value && Number.isNaN(new Date(value).valueOf())) issues.push({ code: 'INVALID_LEGACY_DATA', owner, path, message: `invalid timestamp: ${value}` });
  };
  for (const field of data.globalFields) validTimestamp(field.updatedAt, `globalField:${field.id}`, 'updatedAt');
  for (const rule of data.materialStateRules) validTimestamp(rule.updatedAt, `materialStateRule:${rule.id}`, 'updatedAt');
  for (const material of data.materials) for (const image of material.images ?? []) validTimestamp(image.uploadedAt, `material:${material.id}`, `images.${image.id}.uploadedAt`);
  for (const scene of data.scenes) for (const subscene of scene.subscenes) for (const version of subscene.versions) {
    validTimestamp(version.updatedAt, `task:${scene.id}/${subscene.code}/${version.version}`, 'updatedAt');
    for (const attachment of version.attachments ?? []) validTimestamp(attachment.uploadedAt, `task:${scene.id}/${subscene.code}/${version.version}`, `attachments.${attachment.id}.uploadedAt`);
    for (const rule of version.materialStateRules ?? []) validTimestamp(rule.updatedAt, `task:${scene.id}/${subscene.code}/${version.version}`, `materialStateRules.${rule.id}.updatedAt`);
    if ((version.requiredDurationHours ?? 0) < 0 && version.requiredDurationHours !== -1) issues.push({ code: 'INVALID_LEGACY_DATA', owner: `task:${scene.id}/${subscene.code}/${version.version}`, path: 'requiredDurationHours', message: `negative duration is not the -1 unset sentinel: ${version.requiredDurationHours}` });
    version.materials.forEach((material, index) => {
      if (!material.quantity.unit) issues.push({ code: 'INVALID_LEGACY_DATA', owner: `task:${scene.id}/${subscene.code}/${version.version}`, path: `materials[${index}].quantity.unit`, message: 'quantity unit is required' });
      if (material.quantity.mode === 'range' && (!Number.isFinite(material.quantity.min) || !Number.isFinite(material.quantity.max) || material.quantity.min! > material.quantity.max!)) issues.push({ code: 'INVALID_LEGACY_DATA', owner: `task:${scene.id}/${subscene.code}/${version.version}`, path: `materials[${index}].quantity`, message: 'range quantity requires ordered finite min/max' });
      if (material.quantity.mode === 'fixed' && !Number.isFinite(material.quantity.value)) issues.push({ code: 'INVALID_LEGACY_DATA', owner: `task:${scene.id}/${subscene.code}/${version.version}`, path: `materials[${index}].quantity.value`, message: 'fixed quantity requires a finite value' });
    });
    for (const [stateIndex, state] of (version.objectStates.duringOperation ?? []).entries()) for (const [parameterIndex, parameter] of state.parameters.entries()) {
      if (parameter.sampling?.mode === 'range' && (!Number.isFinite(parameter.sampling.min) || !Number.isFinite(parameter.sampling.max) || parameter.sampling.min! > parameter.sampling.max!)) issues.push({ code: 'INVALID_LEGACY_DATA', owner: `task:${scene.id}/${subscene.code}/${version.version}`, path: `objectStates.duringOperation[${stateIndex}].parameters[${parameterIndex}].sampling`, message: 'range sampling requires ordered finite min/max' });
      if (parameter.sampling?.mode === 'fixed' && !Number.isFinite(parameter.sampling.value)) issues.push({ code: 'INVALID_LEGACY_DATA', owner: `task:${scene.id}/${subscene.code}/${version.version}`, path: `objectStates.duringOperation[${stateIndex}].parameters[${parameterIndex}].sampling.value`, message: 'fixed sampling requires a finite value' });
    }
  }
  for (const requirement of data.requirements) for (const version of requirement.versions) {
    const owner = `requirement:${requirement.id}/${version.version}`;
    validTimestamp(version.updatedAt, owner, 'updatedAt');
    if (version.deadline && !dateValue(version.deadline)) issues.push({ code: 'INVALID_LEGACY_DATA', owner, path: 'deadline', message: `invalid date: ${version.deadline}` });
    if (version.requiredDurationHours < 0 && version.requiredDurationHours !== -1) issues.push({ code: 'INVALID_LEGACY_DATA', owner, path: 'requiredDurationHours', message: `negative duration is not the -1 unset sentinel: ${version.requiredDurationHours}` });
    version.selectedSubscenes.forEach((selected, index) => {
      if (selected.targetDurationHours < 0 && selected.targetDurationHours !== -1) issues.push({ code: 'INVALID_LEGACY_DATA', owner, path: `selectedSubscenes[${index}].targetDurationHours`, message: `negative duration is not the -1 unset sentinel: ${selected.targetDurationHours}` });
      if ((selected.targetCollectionCount ?? 0) < 0) issues.push({ code: 'INVALID_LEGACY_DATA', owner, path: `selectedSubscenes[${index}].targetCollectionCount`, message: 'collection count cannot be negative' });
    });
    for (const attachment of version.attachments ?? []) validTimestamp(attachment.uploadedAt, owner, `attachments.${attachment.id}.uploadedAt`);
  }
  const attachments = collectAttachments(data, issues);
  const attachmentNames = new Map([...attachments].map(([id, item]) => [id, item.name]));
  snapshot.attachments = [...attachments.values()].sort((a, b) => stableCompare(a.name, b.name));

  for (const item of data.customers) {
    const name = resourceName('customers', item.id); register(name, `customer:${item.id}`, [`customer:${item.id}`]);
    const canonical = create(CustomerSchema, { name, uid: deterministicUid('customer', item.id), sourceId: item.id, displayName: item.name, primaryContact: { displayName: optional(item.contact.name), phone: optional(item.contact.phone), email: optional(item.contact.email) }, notes: optional(item.notes) });
    snapshot.customers.push(canonical); recordFingerprints[`customer:${item.id}`] = fingerprintRecord(item, canonical);
  }
  for (const item of data.materials) {
    const name = resourceName('materials', item.id); register(name, `material:${item.id}`, [`material:${item.id}`, `material-sku:${item.skuId}`]);
    const canonical = create(MaterialSchema, { name, uid: deterministicUid('material', item.id), sourceId: item.id, displayName: item.type || item.skuId, sku: optional(item.skuId), category: optional(item.type), colors: item.color ? [item.color] : [], compositions: item.material ? [item.material] : [], packaging: optional(item.packageType), size: optional(item.size), weight: optional(item.weight), images: (item.images ?? []).flatMap((image) => attachmentNames.get(image.id) ?? []) });
    snapshot.materials.push(canonical); recordFingerprints[`material:${item.id}`] = fingerprintRecord(item, canonical);
  }
  for (const item of data.scenes) {
    const name = resourceName('scenes', item.id); register(name, `scene:${item.id}`, [`scene:${item.id}`, `scene-display:${item.name}`]);
    const canonical = create(SceneSchema, { name, uid: deterministicUid('scene', item.id), sourceId: item.id, displayName: item.name, description: optional(item.description) });
    snapshot.scenes.push(canonical); recordFingerprints[`scene:${item.id}`] = fingerprintRecord({ id: item.id, name: item.name, description: item.description }, canonical);
  }
  for (const item of data.globalFields) {
    const name = resourceName('globalFields', item.id); register(name, `globalField:${item.id}`, [`globalField:${item.id}`]);
    const canonical = create(GlobalFieldSchema, { name, uid: deterministicUid('globalField', item.id), sourceId: item.id, group: globalFieldGroup[item.group], label: item.label, value: item.value, category: optional(item.category), description: optional(item.description), status: item.status === 'active' ? GlobalFieldStatus.ACTIVE : GlobalFieldStatus.INACTIVE, updateTime: timestamp(item.updatedAt) });
    snapshot.globalFields.push(canonical); recordFingerprints[`globalField:${item.id}`] = fingerprintRecord(item, canonical);
  }
  for (const item of data.materialStateRules) {
    const name = resourceName('materialStateRules', item.id); register(name, `materialStateRule:${item.id}`, [`materialStateRule:${item.id}`, `materialStateRule-type:${item.materialType}`]);
    const canonical = create(MaterialStateRuleSchema, { name, uid: deterministicUid('materialStateRule', item.id), sourceId: item.id, ...item, updateTime: timestamp(item.updatedAt) });
    snapshot.materialStateRules.push(canonical); recordFingerprints[`materialStateRule:${item.id}`] = fingerprintRecord(item, canonical);
  }

  const robotById = new Map<string, string>();
  for (const item of data.robotModels) {
    const name = resourceName('robotModels', item.id); const revision = revisionName(name, '1.0.0', 'current');
    const canonical = create(RobotModelSchema, { name, uid: deterministicUid('robotModel', item.id), sourceId: item.id, displayName: [item.brand, item.model].filter(Boolean).join(' ') || item.id, manufacturer: optional(item.brand), modelCode: optional(item.model), endEffector: optional(item.terminal), topics: Object.entries(item.topics).sort(([a], [b]) => stableCompare(a, b)).map(([id, topic]) => ({ id: canonicalId(id, `${item.id}:topic:${id}`), topic })), extraTopicRequirements: Object.entries(item.extraTopicRequirements).sort(([a], [b]) => stableCompare(a, b)).map(([topicId, requirement]) => ({ topicId: canonicalId(topicId, `${item.id}:topic:${topicId}`), requirement })), currentRevision: revision });
    snapshot.robotModels.push(canonical); snapshot.robotModelRevisions.push(create(RobotModelRevisionSchema, { name: revision, snapshot: canonical, versionLabel: '1.0.0', sourceVersionId: 'current' }));
    robotById.set(item.id, revision); register(name, `robotModel:${item.id}`, [`robotModel:${item.id}`]); register(revision, `robotModelRevision:${item.id}`, [`robotModelRevision:${item.id}:current`]);
    recordFingerprints[`robotModel:${item.id}`] = fingerprintRecord(item, canonical);
  }

  const materialNames = new Map(data.materials.map((item) => [item.id, resourceName('materials', item.id)]));
  const sceneNames = new Map(data.scenes.map((item) => [item.id, resourceName('scenes', item.id)]));
  const taskCandidates: Array<{ revision: string; sceneName: string; code: string; subsceneName: string; title: string; version: string; versionId?: string; lifecycle: Lifecycle }> = [];
  for (const scene of data.scenes) for (const subscene of scene.subscenes) {
    const taskLegacyId = `${scene.id}-${subscene.code}`;
    const taskName = resourceName('taskSops', taskLegacyId); register(taskName, `taskSop:${scene.id}/${subscene.code}`, [`taskSop:${taskLegacyId}`, `taskSop-display:${scene.name}/${subscene.name}`]);
    const revisions: ReturnType<typeof create<typeof TaskSopRevisionSchema>>[] = [];
    const revisionByVersionId = new Map(subscene.versions.filter((version) => version.versionId).map((version) => [version.versionId!, revisionName(taskName, version.version, version.versionId)]));
    subscene.versions.forEach((version, index) => {
      const revName = revisionName(taskName, version.version, version.versionId);
      const owner = `taskSopRevision:${scene.id}/${subscene.code}/${version.version}`;
      const previousRevision = version.parentVersionId ? revisionByVersionId.get(version.parentVersionId) : index > 0 ? revisionName(taskName, subscene.versions[index - 1].version, subscene.versions[index - 1].versionId) : undefined;
      if (version.parentVersionId && !previousRevision) issues.push({ code: 'UNRESOLVED_REFERENCE', owner, path: 'parentVersionId', message: `parent revision not found: ${version.parentVersionId}` });
      const taskAttachments = (version.attachments ?? []).flatMap((item) => attachmentNames.get(item.id) ?? []);
      const snapshotMessage = create(TaskSopSchema, { name: taskName, uid: deterministicUid('taskSop', taskLegacyId), sourceId: taskLegacyId, displayName: version.title || subscene.name, description: optional(version.description), scene: sceneNames.get(scene.id)!, lifecycle: lifecycle(version.status), spec: toTaskSpec(version, materialNames, attachmentNames, issues, owner), attachments: taskAttachments, currentRevision: revName, updateTime: timestamp(version.updatedAt), referenceUris: version.references.recordUrls, referenceAttachments: version.references.attachments.map((item) => ({ fileToken: item.fileToken, filename: item.name, sizeBytes: BigInt(item.size) })), legacySceneDisplayName: optional(version.sceneName ?? scene.name), legacySubsceneDisplayName: optional(version.subsceneName ?? subscene.name), legacySubsceneCode: subscene.code });
      const materialSet = new Set(snapshotMessage.spec?.objects.flatMap((object) => object.material ? [object.material] : []) ?? []);
      const frozenMaterials = snapshot.materials.filter((material) => materialSet.has(material.name));
      const frozenGlobalFields = selectFrozenGlobalFields(taskVocabularyReferences(version), snapshot.globalFields, issues, owner);
      const attachmentSet = collectResourceReferences(snapshotMessage, 'attachments/');
      for (const material of frozenMaterials) for (const image of material.images) attachmentSet.add(image);
      const embeddedRuleNames = new Set(snapshotMessage.spec?.materialStateRules.map((rule) => rule.name) ?? []);
      const frozen = create(FrozenDependencyContextSchema, {
        materials: frozenMaterials,
        scenes: snapshot.scenes.filter((candidate) => candidate.name === snapshotMessage.scene),
        globalFields: frozenGlobalFields,
        materialStateRules: snapshot.materialStateRules.filter((rule) => embeddedRuleNames.has(rule.name)),
        attachments: snapshot.attachments.filter((attachment) => attachmentSet.has(attachment.name)),
      });
      const revision = create(TaskSopRevisionSchema, { name: revName, snapshot: snapshotMessage, previousRevision, versionLabel: version.version, createTime: timestamp(version.updatedAt), frozenDependencies: frozen, sourceVersionId: version.versionId });
      revisions.push(revision); register(revName, owner, [version.versionId ? `taskSopRevision-id:${version.versionId}` : '', `taskSopRevision-display:${scene.name}/${subscene.name}/${version.version}`, `taskSopRevision-title:${scene.name}/${version.title}/${version.version}`]);
      taskCandidates.push({ revision: revName, sceneName: scene.name, code: subscene.code, subsceneName: subscene.name, title: version.title, version: version.version, versionId: version.versionId, lifecycle: lifecycle(version.status) });
      recordFingerprints[owner] = fingerprintRecord(version, revision);
    });
    const current = revisions[revisions.length - 1];
    if (current?.snapshot) snapshot.taskSops.push(current.snapshot);
    snapshot.taskSopRevisions.push(...revisions);
  }

  const resolveTaskRevision = (version: RequirementVersion['selectedSubscenes'][number], owner: string, index: number) => {
    const explicitId = version.taskSop?.versionId;
    const versionLabel = version.taskSop?.version ?? version.version;
    const title = version.taskSop?.title ?? version.title ?? version.subsceneName;
    const sceneName = version.taskSop?.sceneName ?? version.sceneName;
    const code = version.subsceneCode;
    let candidates = taskCandidates.filter((item) =>
      (!explicitId || item.versionId === explicitId) &&
      (!sceneName || item.sceneName === sceneName) &&
      (!code || item.code === code) &&
      (!title || item.subsceneName === title || item.title === title) &&
      (!versionLabel || item.version === versionLabel));
    candidates = candidates.filter((item, candidateIndex, all) => all.findIndex((other) => other.revision === item.revision) === candidateIndex);
    if (candidates.length === 1) return candidates[0];
    issues.push({ code: candidates.length ? 'AMBIGUOUS_REFERENCE' : 'UNRESOLVED_REFERENCE', owner, path: `selectedSubscenes[${index}]`, message: candidates.length ? 'task reference is ambiguous' : 'task reference cannot be resolved', candidates: candidates.map((item) => item.revision) });
    return undefined;
  };

  for (const item of data.requirements) {
    const name = resourceName('requirements', item.id); register(name, `requirement:${item.id}`, [`requirement:${item.id}`]);
    const revisionByVersionId = new Map(item.versions.filter((version) => version.versionId).map((version) => [version.versionId!, revisionName(name, version.version, version.versionId)]));
    const revisions = item.versions.map((version, versionIndex) => {
      const revName = revisionName(name, version.version, version.versionId); const owner = `requirementRevision:${item.id}/${version.version}`;
      const customerName = version.customerId ? registry.aliases.get(`customer:${version.customerId}`) : undefined;
      if (version.customerId && !customerName) issues.push({ code: 'UNRESOLVED_REFERENCE', owner, path: 'customerId', message: `customer not found: ${version.customerId}` });
      const robotRevision = version.robotModelId ? robotById.get(version.robotModelId) : undefined;
      if (version.robotModelId && !robotRevision) issues.push({ code: 'UNRESOLVED_REFERENCE', owner, path: 'robotModelId', message: `robot model not found: ${version.robotModelId}` });
      const productionItems = version.selectedSubscenes.map((selected, index) => {
        const hasTaskSelection = Boolean(selected.taskSop || selected.version || selected.subsceneCode || selected.subsceneName);
        const resolved = hasTaskSelection ? resolveTaskRevision(selected, owner, index) : undefined;
        const target = selected.targetDurationHours > 0 || (selected.targetCollectionCount ?? 0) > 0 ? { duration: durationHours(selected.targetDurationHours), collectionCount: selected.targetCollectionCount && selected.targetCollectionCount > 0 ? BigInt(selected.targetCollectionCount) : undefined } : undefined;
        return { id: canonicalId(selected.id ?? selected.subsceneCode ?? `item-${index + 1}`, `${owner}:item:${index}`), displayName: selected.title ?? selected.subsceneName ?? resolved?.title ?? `Item ${index + 1}`, description: optional(selected.description), taskSopRevision: resolved?.revision ?? '', target, legacySceneName: optional(selected.sceneName), legacySubsceneCode: optional(selected.subsceneCode), legacySubsceneName: optional(selected.subsceneName), legacyVersionLabel: optional(selected.taskSop?.version ?? selected.version), legacyVersionId: optional(selected.taskSop?.versionId), legacyParentVersionId: optional(selected.taskSop?.parentVersionId), legacyLifecycle: selected.taskSop?.status ? lifecycle(selected.taskSop.status) : resolved?.lifecycle };
      });
      const attachmentList = (version.attachments ?? []).flatMap((attachment) => attachmentNames.get(attachment.id) ?? []);
      const canonical = create(RequirementSchema, {
        name, uid: deterministicUid('requirement', item.id), sourceId: item.id, displayName: version.title, lifecycle: lifecycle(version.status), attachments: attachmentList, currentRevision: revName, updateTime: timestamp(version.updatedAt),
        spec: {
          customer: customerName ?? '', robotModelRevision: robotRevision ?? '', projectDisplayName: optional(version.projectName), businessGoal: version.businessGoal, deadline: dateValue(version.deadline), sourceUri: optional(version.sourceBaseUrl), priority: priority(version.priority), requestedSceneNames: version.requestedScenes,
          aggregateTarget: version.requiredDurationHours > 0 ? { duration: durationHours(version.requiredDurationHours) } : undefined,
          attachmentNotes: optional(version.attachmentNotes), extraTopicRequirementsText: optional(version.extraTopicRequirementsText), productionItems,
          globalRequirements: { randomizationNotes: optional(version.globalRandomizationRequirements), additionalNotes: optional(version.additionalNotes), collectionPolicy: { allowed: requirementRules(version.allowedOperations, 'allowed'), acceptable: requirementRules(version.acceptableOperations, 'acceptable'), forbidden: version.forbiddenOperations.flatMap((group, index) => requirementRules(group.operations, `forbidden-${index + 1}`, group.category)) }, annotationPolicy: { allowed: requirementRules(version.annotation.allowedOperations, 'annotation-allowed'), forbidden: requirementRules(version.annotation.forbiddenOperations, 'annotation-forbidden') } },
          delivery: { formats: version.delivery.formats, method: optional(version.delivery.method), languages: version.delivery.languages.map((language) => ({ code: language.code, displayName: optional(language.name) })), dataStructureUri: optional(version.delivery.dataStructureUrl) },
          annotation: { required: version.annotation.required, types: version.annotation.types }, qualityInspection: { required: version.qualityInspection.required, samplingPolicy: optional(version.qualityInspection.samplingPolicy) },
        },
      });
      const previousRevision = version.parentVersionId ? revisionByVersionId.get(version.parentVersionId) : versionIndex > 0 ? revisionName(name, item.versions[versionIndex - 1].version, item.versions[versionIndex - 1].versionId) : undefined;
      if (version.parentVersionId && !previousRevision) issues.push({ code: 'UNRESOLVED_REFERENCE', owner, path: 'parentVersionId', message: `parent revision not found: ${version.parentVersionId}` });
      const requirementAttachmentSet = new Set(attachmentList);
      const frozen = create(FrozenDependencyContextSchema, {
        customers: snapshot.customers.filter((customer) => customer.name === customerName),
        globalFields: selectFrozenGlobalFields(requirementVocabularyReferences(version), snapshot.globalFields, issues, owner),
        attachments: snapshot.attachments.filter((attachment) => requirementAttachmentSet.has(attachment.name)),
      });
      const revision = create(RequirementRevisionSchema, { name: revName, snapshot: canonical, previousRevision, versionLabel: version.version, createTime: timestamp(version.updatedAt), frozenDependencies: frozen, sourceVersionId: version.versionId });
      register(revName, owner, [version.versionId ? `requirementRevision-id:${version.versionId}` : '']); recordFingerprints[owner] = fingerprintRecord(version, revision);
      return revision;
    });
    const current = revisions[revisions.length - 1]; if (current?.snapshot) snapshot.requirements.push(current.snapshot);
    snapshot.requirementRevisions.push(...revisions);
  }

  for (const collision of registry.collisions) issues.push({ code: 'COLLISION', owner: collision.contender, path: collision.canonical, message: `identity already owned by ${collision.owner}` });
  for (const key of Object.keys(snapshot) as Array<keyof CanonicalSnapshot>) if (Array.isArray(snapshot[key])) (snapshot[key] as unknown[]).sort((left, right) => stableCompare((left as { name: string }).name ?? '', (right as { name: string }).name ?? ''));
  const semanticDigest = canonicalSemanticDigest(snapshot);
  const generationId = `v1alpha1-${sourceFingerprint.slice(0, 16)}`;
  const report = finalizeReport({ generationId, sourceFingerprint, semanticDigest, cardinalities: canonicalCardinalities(snapshot), aliases: Object.fromEntries([...registry.aliases].sort(([a], [b]) => stableCompare(a, b))), recordFingerprints: Object.fromEntries(Object.entries(recordFingerprints).sort(([a], [b]) => stableCompare(a, b))), explicitlyExcludedLegacyPaths: excludedLegacyPaths, documentedNormalizations, issues });
  return { snapshot, report };
}

export { canonicalSchemaVersion };
