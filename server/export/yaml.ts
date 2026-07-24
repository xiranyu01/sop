import YAML from 'yaml';
import { RootKind, type ExportBundle, type FrozenExportContent } from '../../gen/coscene/sop/export/v1alpha1/bundle_pb';
import {
  GlobalFieldGroup,
  type OperationPolicy,
  type OperationStep,
  type RandomizedField,
} from '../../gen/coscene/sop/v1alpha1/common_pb';
import { removeLegacySyntheticMaterialRandomizationConstraints } from '../../shared/domain/randomization';
import { resolveRandomFieldDisplayName } from '../../shared/domain/randomFieldPresentation';
import { verifyExportBundle } from './codec';

type TaskSopEntry = FrozenExportContent['taskSops'][number];
type RequirementEntry = FrozenExportContent['requirements'][number];
type AttachmentEntry = FrozenExportContent['attachments'][number];
type GlobalFieldEntry = FrozenExportContent['globalFields'][number];
type TaskSopSpec = NonNullable<TaskSopEntry['spec']>;

export type DomainYamlOptions = {
  parentRevisionUids?: ReadonlyMap<string, string>;
  requirementTaskSops?: ReadonlyMap<string, { content: FrozenExportContent; taskSop: TaskSopEntry }>;
};

// Domain YAML evolves independently from the internal frozen bundle format.
export const domainYamlSchemaVersion = '2.0.1' as const;
export const domainYamlFormat = 'coscene.sop.export' as const;

function attachmentUrls(refs: string[], attachments: ReadonlyMap<string, AttachmentEntry>): string[] {
  return refs.map((ref) => attachments.get(ref)?.publicUri).filter((value): value is string => Boolean(value));
}

function statusLabel(): string {
  return '已确认';
}

function quantity(value: TaskSopSpec['objects'][number]['quantity']): Record<string, unknown> {
  if (!value) return { mode: '固定', value: 1, unit: '件' };
  if (value.amount.case === 'range') {
    return {
      mode: '范围',
      min: value.amount.value.minValue,
      max: value.amount.value.maxValue,
      unit: value.unit,
    };
  }
  return {
    mode: '固定',
    value: value.amount.case === 'fixedValue' ? value.amount.value : 1,
    unit: value.unit,
  };
}

function attributes(values: Array<{ key: string; values: string[] }>): Array<Record<string, unknown>> {
  return values.map((value) => ({ key: value.key, values: value.values }));
}

function referencePath(values: Array<{ level: number; referenceObject?: string; relativePosition?: string }>) {
  return values.map((value) => ({
    level: value.level,
    reference_object: value.referenceObject || '',
    relative_position: value.relativePosition || '',
  }));
}

function randomFieldName(field: RandomizedField, material: boolean, globalFields: GlobalFieldEntry[]): string {
  const group = material ? GlobalFieldGroup.MATERIAL_RANDOM_FIELD : GlobalFieldGroup.ROBOT_RANDOM_FIELD;
  return resolveRandomFieldDisplayName(field, material, globalFields
    .filter((candidate) => candidate.group === group)
    .map((candidate) => ({
      label: candidate.label,
      value: candidate.value,
      sourceId: candidate.source?.sourceId,
    })));
}

function steps(values: OperationStep[]): Array<Record<string, unknown>> {
  return [...values]
    .sort((left, right) => left.order - right.order)
    .map((step) => ({
      order: step.order,
      description: step.description,
      ...(step.atomicSkill !== undefined ? { atomic_skill: step.atomicSkill } : {}),
      ...(step.englishDescription !== undefined ? { english_description: step.englishDescription } : {}),
      ...(step.englishAtomicSkill !== undefined ? { english_atomic_skill: step.englishAtomicSkill } : {}),
    }));
}

function operationDescriptions(values: OperationPolicy['allowed']): string[] {
  return values.map((value) => value.description).filter(Boolean);
}

function operationPlan(value: TaskSopSpec['collection']): Record<string, unknown> {
  const result: Record<string, unknown> = {
    steps: steps(value?.steps || []),
    allowed_operations: operationDescriptions(value?.policy?.allowed || []),
    acceptable_operations: operationDescriptions(value?.policy?.acceptable || []),
    forbidden_operations: operationDescriptions(value?.policy?.forbidden || []),
  };
  if (value?.stepRandomization?.enabled) {
    result.step_randomization = {
      enabled: true,
      start_order: value.stepRandomization.startStepNumber,
      end_order: value.stepRandomization.endStepNumber,
    };
  }
  return result;
}

function annotationPlan(value: TaskSopSpec['annotation']): Record<string, unknown> {
  return {
    steps: steps(value?.steps || []),
    allowed_operations: operationDescriptions(value?.policy?.allowed || []),
    forbidden_operations: operationDescriptions(value?.policy?.forbidden || []),
  };
}

function taskSopDocument(
  content: FrozenExportContent,
  taskSop: TaskSopEntry,
  options: DomainYamlOptions,
): Record<string, unknown> {
  const attachments = new Map(content.attachments.map((item) => [item.ref, item]));
  const materials = new Map(content.materials.map((item) => [item.ref, item]));
  const scenes = new Map(content.scenes.map((item) => [item.ref, item]));
  const objects = new Map(taskSop.spec?.objects.map((item) => [item.id, item]) || []);
  const objectName = (id: string) => objects.get(id)?.displayName || id;
  const version = taskSop.revision?.versionLabel || content.versionLabel;

  const mappedMaterials = (taskSop.spec?.objects || []).map((object) => {
    const material = object.materialRef ? materials.get(object.materialRef) : undefined;
    const descriptor = object.materialDescriptor;
    return {
      sku_id: descriptor?.sku || material?.sku || '',
      material_id: object.id,
      name: object.displayName || descriptor?.category || material?.displayName || '',
      quantity: quantity(object.quantity),
      color: descriptor?.color || material?.colors.join('/') || '',
      material: descriptor?.composition || material?.compositions.join('/') || '',
      package_type: descriptor?.packaging || material?.packaging || '',
      images: attachmentUrls(object.attachmentRefs, attachments),
    };
  });

  const initialStates = (taskSop.spec?.objectStates?.initial || []).map((state) => ({
    object: objectName(state.objectId),
    allowed_locations: state.allowedLocations.map((location) => ({
      location: location.displayName || '',
      reference_path: referencePath(location.referencePath),
      support_surface: location.supportSurface || '',
      allowed_regions: location.regions,
      allowed_pose: location.poses,
      allowed_form: location.forms,
      parameters: attributes(location.parameters),
      constraints: location.constraints,
      ...(location.collectorInstruction !== undefined ? { collector_instruction: location.collectorInstruction } : {}),
      example_images: attachmentUrls(location.exampleAttachmentRefs, attachments),
    })),
  }));

  const targetStates = (taskSop.spec?.objectStates?.target || []).map((state) => {
    const location = state.requiredLocation;
    return {
      object: objectName(state.objectId),
      required_location: location?.displayName || '',
      required_regions: location?.regions || [],
      required_pose: location?.poses || [],
      required_form: location?.forms || [],
      reference_path: referencePath(location?.referencePath || []),
      support_surface: location?.supportSurface || '',
      parameters: attributes(location?.parameters || []),
      constraints: location?.constraints || [],
      ...(location?.collectorInstruction !== undefined ? { collector_instruction: location.collectorInstruction } : {}),
      example_images: attachmentUrls(location?.exampleAttachmentRefs || [], attachments),
    };
  });

  const robotRandomization = taskSop.spec?.randomization?.robotInitialState;
  const materialRandomization = taskSop.spec?.randomization?.objectInitialStates || [];
  const sceneName = scenes.get(taskSop.sceneRef)?.displayName || '';

  return {
    sop_version: version,
    sop_version_id: taskSop.revision?.revisionUid || '',
    parent_sop_version_id: options.parentRevisionUids?.get(taskSop.revision?.revisionName || '') || '',
    status: statusLabel(),
    scene_name: sceneName,
    task_sop_name: taskSop.displayName,
    description: taskSop.description || '',
    attachments: attachmentUrls(taskSop.attachmentRefs, attachments),
    environment_config: {
      config_version: version,
      materials: mappedMaterials,
      robot_state: {
        initial: taskSop.spec?.robotState?.initial || '',
        target: taskSop.spec?.robotState?.target || '',
      },
      object_states: {
        initial: initialStates,
        target: targetStates,
      },
      randomization: {
        robot_initial_state: {
          enabled: robotRandomization?.enabled || false,
          ...(robotRandomization?.change?.intervalRecords !== undefined
            ? { change_interval_records: robotRandomization.change.intervalRecords }
            : {}),
          randomized_fields: (robotRandomization?.fields || []).map((field) => ({
            name: randomFieldName(field, false, content.globalFields),
            constraints: field.constraints,
          })),
        },
        material_initial_state: {
          rules: materialRandomization.map((rule) => ({
            target_materials: rule.objectIds.map(objectName),
            ...(rule.change?.intervalRecords !== undefined
              ? { change_interval_records: rule.change.intervalRecords }
              : {}),
            randomized_fields: rule.fields.map((field) => randomFieldName(field, true, content.globalFields)),
            collector_instruction: rule.collectorInstruction || '',
            constraints: removeLegacySyntheticMaterialRandomizationConstraints(rule.constraints),
            example_images: attachmentUrls(rule.exampleAttachmentRefs, attachments),
          })),
        },
      },
    },
    collection_config: {
      config_version: version,
      operation: operationPlan(taskSop.spec?.collection),
    },
    annotation_config: {
      config_version: version,
      annotation: annotationPlan(taskSop.spec?.annotation),
    },
  };
}

function hours(value: string | undefined): number {
  if (!value) return 0;
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match) return 0;
  return Number(match[1] || 0) + Number(match[2] || 0) / 60 + Number(match[3] || 0) / 3600;
}

function count(value: bigint | undefined): number | string {
  if (value === undefined) return 0;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function topicMap(values: FrozenExportContent['robotModelRevisions'][number]['topics']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    if (value.topic) {
      result[value.topic] = value.constraints.join('; ');
      continue;
    }
    const [topic, ...rest] = value.id.trim().split(/\s+/);
    if (topic) result[topic] = [...rest, ...value.constraints].join(' ');
  }
  return result;
}

function requirementRules(values: OperationPolicy['allowed']) {
  return values.map((value) => ({ operation: value.description, note: value.note || '' }));
}

function forbiddenRequirementRules(values: OperationPolicy['forbidden']) {
  const groups = new Map<string, OperationPolicy['forbidden']>();
  for (const value of values) {
    const category = value.category || '';
    groups.set(category, [...(groups.get(category) || []), value]);
  }
  return [...groups.entries()].map(([category, operations]) => ({
    category,
    operations: requirementRules(operations),
  }));
}

function requirementDocument(
  content: FrozenExportContent,
  requirement: RequirementEntry,
  options: DomainYamlOptions,
): Record<string, unknown> {
  const attachments = new Map(content.attachments.map((item) => [item.ref, item]));
  const customer = content.customers.find((item) => item.ref === requirement.spec?.customerRef);
  const robot = content.robotModelRevisions.find((item) => item.ref === requirement.spec?.robotModelRevisionRef);
  if (!customer) throw new TypeError('需求导出缺少客户信息');
  if (!robot) throw new TypeError('需求导出缺少机器人型号信息');

  const global = requirement.spec?.globalRequirements;
  const productionItems = requirement.spec?.productionItems || [];
  const selectedTaskSops = productionItems.map((item) => {
    const resolved = options.requirementTaskSops?.get(item.id);
    if (resolved) return resolved;
    const taskSop = content.taskSops.find((candidate) => candidate.ref === item.taskSopRef);
    if (!taskSop) throw new TypeError(`生产需求项缺少任务 SOP：${item.displayName}`);
    return { content, taskSop };
  });

  return {
    basic_info: {
      title: requirement.displayName,
      requirement_version: requirement.revision?.versionLabel || content.versionLabel,
      requirement_version_id: requirement.revision?.revisionUid || content.revisionUid,
      parent_requirement_version_id: options.parentRevisionUids?.get(requirement.revision?.revisionName || '') || '',
      status: statusLabel(),
      project_name: requirement.spec?.projectDisplayName || '',
      deadline: requirement.spec?.deadline || '',
      business_goal: requirement.spec?.businessGoal || '',
      required_duration_hours: hours(requirement.spec?.aggregateTarget?.duration),
      original_requirement_source: requirement.spec?.sourceUri || '',
      attachments: attachmentUrls(requirement.attachmentRefs, attachments),
    },
    customer: {
      id: customer.source?.sourceId || customer.source?.uid || '',
      name: customer.displayName,
      contact: {
        name: customer.primaryContact?.displayName || '',
        phone: customer.primaryContact?.phone || '',
        email: customer.primaryContact?.email || '',
      },
    },
    robot: {
      id: robot.source?.uid || '',
      brand: robot.manufacturer || '',
      model: robot.modelCode || robot.displayName,
      terminal: robot.endEffector || '',
      topics: topicMap(robot.topics),
    },
    global_requirements: {
      extra_topic_requirements: requirement.spec?.extraTopicRequirementsText || '',
      global_randomization_requirements: global?.randomizationNotes || '',
      additional_notes: global?.additionalNotes || '',
      collection_operation_requirements: {
        allowed_operations: requirementRules(global?.collectionPolicy?.allowed || []),
        acceptable_operations: requirementRules(global?.collectionPolicy?.acceptable || []),
        forbidden_operations: forbiddenRequirementRules(global?.collectionPolicy?.forbidden || []),
      },
      annotation_operation_requirements: {
        allowed_operations: requirementRules(global?.annotationPolicy?.allowed || []),
        forbidden_operations: requirementRules(global?.annotationPolicy?.forbidden || []),
      },
    },
    delivery_requirements: {
      formats: requirement.spec?.delivery?.formats || [],
      method: requirement.spec?.delivery?.method || '',
      languages: (requirement.spec?.delivery?.languages || []).map((language) => language.displayName || language.code),
    },
    annotation_requirements: {
      required: requirement.spec?.annotation?.required || false,
      types: requirement.spec?.annotation?.types || [],
    },
    quality_inspection_requirements: {
      required: requirement.spec?.qualityInspection?.required || false,
      sampling_policy: requirement.spec?.qualityInspection?.samplingPolicy || '',
    },
    production_requirement_items: productionItems.map((item, index) => {
      const { content: taskContent, taskSop: task } = selectedTaskSops[index];
      const scene = taskContent.scenes.find((candidate) => candidate.ref === task.sceneRef);
      return {
        title: item.displayName,
        description: item.description || '',
        target_duration_hours: hours(item.target?.duration),
        target_collection_count: count(item.target?.collectionCount),
        task_sop: {
          title: task.displayName,
          scene_name: scene?.displayName || item.legacySceneName || '',
          sop_version: task.revision?.versionLabel || item.legacyVersionLabel || '',
          sop_version_id: task.revision?.revisionUid || '',
        },
      };
    }),
    task_sop_details: selectedTaskSops.map(({ content: taskContent, taskSop }) =>
      taskSopDocument(taskContent, taskSop, options)),
  };
}

export function serializeExportBundleYaml(bundle: ExportBundle, options: DomainYamlOptions = {}): string {
  const content = verifyExportBundle(bundle).content!;
  let document: Record<string, unknown>;
  if (content.root?.kind === RootKind.TASK_SOP) {
    const task = content.taskSops.find((item) => item.ref === content.root?.ref);
    if (!task) throw new TypeError('任务 SOP 导出缺少根版本');
    document = {
      format: domainYamlFormat,
      schema_version: domainYamlSchemaVersion,
      task_sop: taskSopDocument(content, task, options),
    };
  } else if (content.root?.kind === RootKind.REQUIREMENT) {
    const requirement = content.requirements.find((item) => item.ref === content.root?.ref);
    if (!requirement) throw new TypeError('需求导出缺少根版本');
    document = {
      format: domainYamlFormat,
      schema_version: domainYamlSchemaVersion,
      requirement: requirementDocument(content, requirement, options),
    };
  } else {
    throw new TypeError('不支持的 YAML 导出根类型');
  }
  return YAML.stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 })
    .replace(/\r\n/g, '\n')
    .replace(/\n*$/, '\n');
}
