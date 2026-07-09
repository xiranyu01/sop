import YAML from 'yaml';
import { appDataSchemaVersion, requirementYamlSchemaVersion, taskSopYamlSchemaVersion } from '../src/schemaVersions';
import type {
  AppData,
  ObjectInitialState,
  ObjectTargetState,
  Requirement,
  RequirementVersion,
  RequestedSubscene,
  RequirementAttachment,
  ScenarioMaterial,
  Scene,
  Subscene,
  SubsceneVersion,
  TextItem,
} from '../src/types';

type BuildRequirementYamlOptions = {
  attachmentPublicBaseUrl?: string;
};

function toSnakeObject(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(toSnakeObject);
  }
  if (!input || typeof input !== 'object') {
    return input;
  }
  return Object.entries(input as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [key, value]) => {
    const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    acc[snakeKey] = toSnakeObject(value);
    return acc;
  }, {});
}

function toSnakeRecord(input: unknown): Record<string, unknown> {
  const value = toSnakeObject(input);
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function keyValueLines(value: string): Record<string, string> {
  return value.split('\n').reduce<Record<string, string>>((acc, line) => {
    const [key, ...rest] = line.split(':');
    if (key?.trim()) {
      acc[key.trim()] = rest.join(':').trim();
    }
    return acc;
  }, {});
}

function omitKeys(input: object, keys: string[]): Record<string, unknown> {
  return Object.entries(input).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (!keys.includes(key)) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function publicAttachmentUrl(publicBaseUrl: string | undefined, storageKey: string): string {
  if (publicBaseUrl) {
    const base = publicBaseUrl.replace(/\/+$/, '');
    const encodedKey = storageKey.split('/').map(encodeURIComponent).join('/');
    return `${base}/${encodedKey}`;
  }
  return `/api/attachments/${encodeURIComponent(storageKey)}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(0, 8);
}

function versionRank(value: string): number[] {
  return value.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function versionId(objectId: string | undefined, version: string | undefined): string {
  if (!objectId || !version) return '';
  return `${objectId}@${version}`;
}

function parentVersionId(objectId: string | undefined, versions: Array<{ version: string }>, currentVersion: string | undefined): string {
  if (!objectId || !currentVersion) return '';
  const sortedVersions = [...versions].sort((left, right) => {
    const leftRank = versionRank(left.version);
    const rightRank = versionRank(right.version);
    for (let index = 0; index < Math.max(leftRank.length, rightRank.length); index += 1) {
      const diff = (leftRank[index] || 0) - (rightRank[index] || 0);
      if (diff !== 0) return diff;
    }
    return left.version.localeCompare(right.version);
  });
  const index = sortedVersions.findIndex((item) => item.version === currentVersion);
  if (index <= 0) return '';
  return versionId(objectId, sortedVersions[index - 1].version);
}

function taskSopObjectId(scene: Scene, subscene: Subscene): string {
  return `sop_${stableHash(`${scene.id}:${subscene.name}`)}`;
}

function requirementVersionId(requirementId: string, version: string): string {
  return `${requirementId}@${version}`;
}

function previousRequirementVersion(requirement: Requirement, versionNumber: string): RequirementVersion | undefined {
  const sortedVersions = [...requirement.versions].sort((left, right) => {
    const leftRank = versionRank(left.version);
    const rightRank = versionRank(right.version);
    for (let index = 0; index < Math.max(leftRank.length, rightRank.length); index += 1) {
      const diff = (leftRank[index] || 0) - (rightRank[index] || 0);
      if (diff !== 0) return diff;
    }
    return left.version.localeCompare(right.version);
  });
  const index = sortedVersions.findIndex((item) => item.version === versionNumber);
  return index > 0 ? sortedVersions[index - 1] : undefined;
}

function requirementParentVersionId(requirement: Requirement, versionNumber: string): string {
  const previous = previousRequirementVersion(requirement, versionNumber);
  return previous ? requirementVersionId(requirement.id, previous.version) : '';
}

function productionItemTitle(selected: RequestedSubscene, index: number): string {
  return selected.title || selected.subsceneName || selected.taskSop?.title || `生产需求项 ${index + 1}`;
}

function productionItemSceneName(selected: RequestedSubscene): string {
  return selected.sceneName || selected.taskSop?.sceneName || '';
}

function selectedTaskSopTitle(selected: RequestedSubscene): string {
  return selected.taskSop?.title || selected.subsceneName || '';
}

function selectedTaskSopVersion(selected: RequestedSubscene): string {
  return selected.taskSop?.version || selected.version || '';
}

function findTaskSopVersion(
  data: AppData,
  selected: RequestedSubscene,
): { sceneName: string; taskSopName: string; scene: Scene; subscene: Subscene; version: SubsceneVersion } {
  const requestedVersion = selectedTaskSopVersion(selected);
  const requestedSceneName = selected.taskSop?.sceneName || selected.sceneName;
  const requestedTitle = selectedTaskSopTitle(selected);
  if (!requestedVersion || !requestedTitle) {
    throw new Error(`生产需求项「${selected.title || selected.subsceneName || '未命名'}」还没有选择任务 SOP`);
  }

  if (selected.subsceneCode) {
    for (const scene of data.scenes) {
      const subscene = scene.subscenes.find((item) => item.code === selected.subsceneCode);
      const versionItem = subscene?.versions.find((item) => item.version === requestedVersion);
      if (subscene && versionItem) {
        return {
          sceneName: selected.sceneName || scene.name,
          taskSopName: requestedTitle || versionItem.title || subscene.name,
          scene,
          subscene,
          version: versionItem,
        };
      }
    }
  }

  for (const scene of data.scenes) {
    if (requestedSceneName && scene.name !== requestedSceneName) continue;
    for (const subscene of scene.subscenes) {
      const versionItem = subscene.versions.find((item) => item.version === requestedVersion);
      if (!versionItem) continue;
      if (subscene.name === requestedTitle || versionItem.title === requestedTitle) {
        return {
          sceneName: scene.name,
          taskSopName: requestedTitle || versionItem.title || subscene.name,
          scene,
          subscene,
          version: versionItem,
        };
      }
    }
  }

  throw new Error(`找不到任务 SOP ${requestedSceneName} / ${requestedTitle} 的版本 ${requestedVersion}`);
}

function mapStatus(status: string): string {
  const statusMap: Record<string, string> = {
    draft: '草稿',
    confirmed: '已确认',
    archived: '已归档',
    pending: '待补充',
    ready: '已完成',
    not_required: '不需要',
    active: '启用',
    inactive: '停用',
  };
  return statusMap[status] || status;
}

function mapQuantityMode(mode: string): string {
  return mode === 'range' ? '范围' : mode === 'fixed' ? '固定' : mode;
}

function mapMaterials(materials: ScenarioMaterial[], allMaterials: AppData['materials'], options: BuildRequirementYamlOptions): unknown {
  return materials.map((material) => ({
    sku_id: material.skuId,
    material_id: material.materialId,
    type: material.type,
    quantity: {
      ...material.quantity,
      mode: mapQuantityMode(material.quantity.mode),
    },
    color: material.color,
    material: material.material,
    package_type: material.packageType,
    images: mapAttachments(allMaterials.find((item) => item.id === material.materialId)?.images, options),
  }));
}

function mapAttachments(attachments: RequirementAttachment[] | undefined, options: BuildRequirementYamlOptions): unknown {
  return (attachments || []).map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    url: publicAttachmentUrl(options.attachmentPublicBaseUrl, attachment.storageKey),
    size: attachment.size,
    content_type: attachment.contentType,
    uploaded_at: attachment.uploadedAt,
  }));
}

function mapExampleImages(ids: string[] | undefined, attachments: SubsceneVersion['attachments'], options: BuildRequirementYamlOptions): unknown {
  return (ids || []).map((id) => {
    const attachment = attachments?.find((item) => item.id === id);
    return {
      attachment_id: id,
      name: attachment?.name || '',
      url: attachment ? publicAttachmentUrl(options.attachmentPublicBaseUrl, attachment.storageKey) : '',
    };
  });
}

function mapObjectStates(
  states: {
    initial: ObjectInitialState[];
    target: ObjectTargetState[];
  },
  attachments: SubsceneVersion['attachments'],
  options: BuildRequirementYamlOptions,
): unknown {
  return {
    initial: states.initial.map((state) => ({
      object: state.object,
      allowed_locations: state.allowedLocations.map((location) => ({
        ...omitKeys(toSnakeRecord(location), ['example_image_attachment_ids']),
        example_images: mapExampleImages(location.exampleImageAttachmentIds, attachments, options),
      })),
    })),
    target: states.target.map((state) => ({
      ...omitKeys(toSnakeRecord(state), ['example_image_attachment_ids']),
      example_images: mapExampleImages(state.exampleImageAttachmentIds, attachments, options),
    })),
  };
}

function normalizeRandomFieldName(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes('initial_position')) return '初始位置';
  if (normalized.includes('initial_yaw')) return '初始朝向';
  if (normalized === 'location' || normalized.includes('位置')) return name.includes('初始') ? name : '物料位置';
  if (normalized === 'pose' || normalized.includes('姿态')) return name.includes('物料') ? name : '物料姿态';
  if (normalized === 'form' || normalized.includes('形态')) return name.includes('物料') ? name : '物料形态';
  return name;
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function mapRandomizedFields(
  fields: Array<{ field?: string; displayName?: string; name?: string; constraints?: string[] }>,
): Array<{ name: string; constraints: string[] }> {
  return fields.map((field) => ({
    name: normalizeRandomFieldName(field.displayName || field.name || field.field || ''),
    constraints: field.constraints || [],
  }));
}

function mapMaterialRandomizedFields(rule: SubsceneVersion['randomization']['materialInitialState']['rules'][number]): string[] {
  return uniqueValues([
    ...rule.randomizedFields.locations.map((item) => normalizeRandomFieldName(item.name)),
    ...rule.randomizedFields.poses.map((item) => normalizeRandomFieldName(item.name)),
    ...rule.randomizedFields.forms.map((item) => normalizeRandomFieldName(item.name)),
  ]);
}

function mapRandomization(
  randomization: SubsceneVersion['randomization'],
  attachments: SubsceneVersion['attachments'],
  options: BuildRequirementYamlOptions,
): unknown {
  const robotInitialState = randomization.robotInitialState;
  return {
    robot_initial_state: {
      enabled: robotInitialState.enabled,
      change_interval_records: robotInitialState.changeIntervalRecords || 1,
      randomized_fields: mapRandomizedFields(robotInitialState.randomizedFields),
    },
    material_initial_state: {
      rules: randomization.materialInitialState.rules.map((rule) => ({
        target_materials: rule.targetMaterials,
        change_interval_records: rule.changeIntervalRecords || 1,
        randomized_fields: mapMaterialRandomizedFields(rule),
        collector_instruction: rule.collectorInstruction || '',
        constraints: rule.constraints || [],
        example_images: mapExampleImages(rule.exampleImageAttachmentIds, attachments, options),
      })),
    },
  };
}

function mapTextItems(items: TextItem[] | undefined): string[] {
  return (items || []).map((item) => item.description || item.type || '').filter(Boolean);
}

function mapOperation(operation: SubsceneVersion['operation']): unknown {
  const result: Record<string, unknown> = {
    steps: operation.steps,
    allowed_operations: mapTextItems(operation.allowedOperations),
    acceptable_operations: mapTextItems(operation.acceptableOperations),
    forbidden_operations: mapTextItems(operation.forbiddenOperations),
  };
  if (operation.stepRandomization?.enabled) {
    result.step_randomization = toSnakeObject(operation.stepRandomization);
  }
  return result;
}

function mapAnnotation(annotation: SubsceneVersion['annotation']): unknown {
  return {
    status: mapStatus(annotation.status),
    steps: annotation.steps || [],
    allowed_operations: mapTextItems(annotation.allowedOperations),
    forbidden_operations: mapTextItems(annotation.forbiddenOperations),
  };
}

function mapScenario(
  sceneName: string,
  taskSopName: string,
  requestedVersion: string,
  taskSopVersionId: string,
  taskSopParentVersionId: string,
  targetDurationHours: number,
  targetCollectionCount: number | undefined,
  subscene: SubsceneVersion,
  allMaterials: AppData['materials'],
  options: BuildRequirementYamlOptions,
): unknown {
  return {
    schema_version: taskSopYamlSchemaVersion,
    version: requestedVersion,
    version_id: taskSopVersionId,
    parent_version_id: taskSopParentVersionId,
    scene_name: sceneName,
    task_sop_name: taskSopName || subscene.title || subscene.description,
    description: subscene.description,
    attachments: mapAttachments(subscene.attachments, options),
    target_duration_hours: targetDurationHours,
    target_collection_count: targetCollectionCount || 0,
    materials: mapMaterials(subscene.materials, allMaterials, options),
    robot_state: toSnakeObject(subscene.robotState),
    randomization: mapRandomization(subscene.randomization, subscene.attachments, options),
    operation: mapOperation(subscene.operation),
    object_states: mapObjectStates(subscene.objectStates, subscene.attachments, options),
    annotation: mapAnnotation(subscene.annotation),
    references: toSnakeObject(subscene.references),
  };
}

export function buildRequirementYaml(
  data: AppData,
  requirement: Requirement,
  version: RequirementVersion,
  options: BuildRequirementYamlOptions = {},
): string {
  const customer = data.customers.find((item) => item.id === version.customerId);
  const robot = data.robotModels.find((item) => item.id === version.robotModelId);

  if (!customer) {
    throw new Error('找不到客户信息，无法导出 YAML');
  }
  if (!robot) {
    throw new Error('找不到机器人型号，无法导出 YAML');
  }

  const resolvedItems = version.selectedSubscenes.map((selected, index) => {
    const resolved = findTaskSopVersion(data, selected);
    const objectId = taskSopObjectId(resolved.scene, resolved.subscene);
    const sopVersion = selectedTaskSopVersion(selected);
    const refVersionId = selected.taskSop?.versionId || versionId(objectId, sopVersion);
    const refParentVersionId = selected.taskSop?.parentVersionId || parentVersionId(objectId, resolved.subscene.versions, sopVersion);
    return {
      selected,
      index,
      ...resolved,
      sopVersion,
      refVersionId,
      refParentVersionId,
    };
  });

  const taskSopDetails = resolvedItems.map(({ selected, sceneName, taskSopName, version: taskSop, sopVersion, refVersionId, refParentVersionId }) =>
    mapScenario(
      productionItemSceneName(selected) || sceneName,
      selectedTaskSopTitle(selected) || taskSopName,
      sopVersion,
      refVersionId,
      refParentVersionId,
      selected.targetDurationHours,
      selected.targetCollectionCount,
      taskSop,
      data.materials,
      options,
    ),
  );

  const productionRequirementItems = resolvedItems.map(({ selected, index, sceneName, taskSopName, version: taskSop, sopVersion, refVersionId, refParentVersionId }) => ({
    title: productionItemTitle(selected, index),
    description: selected.description || '',
    scene_name: productionItemSceneName(selected) || sceneName,
    target_duration_hours: selected.targetDurationHours,
    target_collection_count: selected.targetCollectionCount || 0,
    task_sop: {
      schema_version: taskSopYamlSchemaVersion,
      title: selectedTaskSopTitle(selected) || taskSopName,
      scene_name: selected.taskSop?.sceneName || sceneName,
      version: sopVersion,
      version_id: refVersionId,
      parent_version_id: refParentVersionId,
      status: mapStatus(taskSop.status),
    },
  }));

  const doc = {
    schema_version: requirementYamlSchemaVersion,
    schema_versions: {
      app_data: data.metadata?.appDataSchemaVersion || appDataSchemaVersion,
      requirement_yaml: data.metadata?.requirementYamlSchemaVersion || requirementYamlSchemaVersion,
      task_sop_yaml: data.metadata?.taskSopYamlSchemaVersion || taskSopYamlSchemaVersion,
    },
    requirement: {
      id: requirement.id,
      title: version.title,
      version: version.version,
      version_id: version.versionId || requirementVersionId(requirement.id, version.version),
      parent_version_id: version.parentVersionId || requirementParentVersionId(requirement, version.version),
      status: mapStatus(version.status),
      project_name: version.projectName,
      priority: version.priority,
      deadline: version.deadline,
      source_base_url: version.sourceBaseUrl || '',
      attachments: mapAttachments(version.attachments, options),
      additional_notes: version.additionalNotes || '',
    },
    customer: {
      id: customer.id,
      name: customer.name,
      contact: customer.contact,
    },
    robot: {
      id: robot.id,
      brand: robot.brand,
      model: robot.model,
      terminal: robot.terminal,
      topics: robot.topics,
      extra_topic_requirements: version.extraTopicRequirementsText
        ? keyValueLines(version.extraTopicRequirementsText)
        : robot.extraTopicRequirements,
    },
    global_requirements: {
      business_goal: {
        intended_use: version.businessGoal,
      },
      scene_data_scope: {
        requested_scenes: Array.from(new Set(version.selectedSubscenes.map(productionItemSceneName).filter(Boolean))).map((sceneName) => ({
          scene_name: sceneName,
          production_requirement_items: version.selectedSubscenes
            .filter((selected) => productionItemSceneName(selected) === sceneName)
            .map((selected) => ({
              title: selected.title || selected.subsceneName || selected.taskSop?.title,
              task_sop_name: selectedTaskSopTitle(selected),
              task_sop_version: selectedTaskSopVersion(selected),
            })),
        })),
      },
      collection: {
        required_duration_hours: version.requiredDurationHours,
        global_randomization_requirements: version.globalRandomizationRequirements || '',
        allowed_operations: version.allowedOperations,
        acceptable_operations: version.acceptableOperations || [],
        forbidden_operations: version.forbiddenOperations,
      },
      annotation: toSnakeObject(version.annotation),
      quality_inspection: toSnakeObject(version.qualityInspection),
      delivery: toSnakeObject(version.delivery),
    },
    production_requirement_items: productionRequirementItems,
    task_sop_details: taskSopDetails,
    traceability: {
      generated_from: `sop-requirement-manager ${new Date().toISOString()}`,
      requirement_id: requirement.id,
      requirement_version: version.version,
      requirement_version_id: version.versionId || requirementVersionId(requirement.id, version.version),
      parent_requirement_version_id: version.parentVersionId || requirementParentVersionId(requirement, version.version),
      schema_versions: {
        app_data: data.metadata?.appDataSchemaVersion || appDataSchemaVersion,
        requirement_yaml: data.metadata?.requirementYamlSchemaVersion || requirementYamlSchemaVersion,
        task_sop_yaml: data.metadata?.taskSopYamlSchemaVersion || taskSopYamlSchemaVersion,
      },
      task_sop_versions: resolvedItems.map(({ selected, sceneName, taskSopName, sopVersion, refVersionId, refParentVersionId }) => ({
        scene_name: selected.taskSop?.sceneName || sceneName,
        task_sop_name: selectedTaskSopTitle(selected) || taskSopName,
        version: sopVersion,
        version_id: refVersionId,
        parent_version_id: refParentVersionId,
      })),
    },
  };

  return YAML.stringify(doc, { lineWidth: 120 });
}
