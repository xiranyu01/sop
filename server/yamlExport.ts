import YAML from 'yaml';
import type {
  AppData,
  ObjectInitialState,
  ObjectTargetState,
  Requirement,
  RequirementVersion,
  ScenarioMaterial,
  SubsceneVersion,
} from '../src/types';

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

function mapRandomization(randomization: SubsceneVersion['randomization']): unknown {
  return toSnakeObject(omitKeys(randomization, ['material' + 'StateDuringOperation']));
}

function findSubsceneVersion(data: AppData, code: string, version: string): { sceneName: string; subscene: SubsceneVersion } {
  for (const scene of data.scenes) {
    const subscene = scene.subscenes.find((item) => item.code === code);
    if (!subscene) {
      continue;
    }
    const versionItem = subscene.versions.find((item) => item.version === version);
    if (versionItem) {
      return { sceneName: scene.name, subscene: versionItem };
    }
  }
  throw new Error(`找不到子场景 ${code} 的版本 ${version}`);
}

function mapMaterials(materials: ScenarioMaterial[]): unknown {
  return materials.map((material) => ({
    sku_id: material.skuId,
    material_id: material.materialId,
    type: material.type,
    quantity: material.quantity,
    color: material.color,
    material: material.material,
    package_type: material.packageType,
  }));
}

function mapAttachments(attachments: SubsceneVersion['attachments']): unknown {
  return (attachments || []).map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    size: attachment.size,
    content_type: attachment.contentType,
    storage_key: attachment.storageKey,
    uploaded_at: attachment.uploadedAt,
  }));
}

function mapObjectStates(states: {
  initial: ObjectInitialState[];
  target: ObjectTargetState[];
}): unknown {
  return toSnakeObject({
    initial: states.initial,
    target: states.target,
  });
}

function mapOperation(operation: SubsceneVersion['operation']): unknown {
  return toSnakeObject({
    steps: operation.steps,
    stepRandomization: operation.stepRandomization,
    allowedOperations: operation.allowedOperations,
    acceptableOperations: operation.acceptableOperations || [],
    forbiddenOperations: operation.forbiddenOperations,
  });
}

function mapAnnotation(annotation: SubsceneVersion['annotation']): unknown {
  return toSnakeObject({
    status: annotation.status,
    steps: annotation.steps || [],
    allowedOperations: annotation.allowedOperations || [],
    forbiddenOperations: annotation.forbiddenOperations || [],
  });
}

function mapScenario(
  code: string,
  sceneName: string,
  requestedVersion: string,
  targetDurationHours: number,
  subscene: SubsceneVersion,
): unknown {
  return {
    scenario_id: code,
    version: requestedVersion,
    scene_name: sceneName,
    sub_scene_name: subscene.title || subscene.description,
    description: subscene.description,
    attachments: mapAttachments(subscene.attachments),
    target_duration_hours: targetDurationHours,
    materials: mapMaterials(subscene.materials),
    robot_state: toSnakeObject(subscene.robotState),
    randomization: mapRandomization(subscene.randomization),
    operation: mapOperation(subscene.operation),
    object_states: mapObjectStates(subscene.objectStates),
    annotation: mapAnnotation(subscene.annotation),
    references: toSnakeObject(subscene.references),
  };
}

export function buildRequirementYaml(data: AppData, requirement: Requirement, version: RequirementVersion): string {
  const customer = data.customers.find((item) => item.id === version.customerId);
  const robot = data.robotModels.find((item) => item.id === version.robotModelId);

  if (!customer) {
    throw new Error('找不到客户信息，无法导出 YAML');
  }
  if (!robot) {
    throw new Error('找不到机器人型号，无法导出 YAML');
  }

  const scenarios = version.selectedSubscenes.map((selected) => {
    const { sceneName, subscene } = findSubsceneVersion(data, selected.subsceneCode, selected.version);
    return mapScenario(
      selected.subsceneCode,
      selected.sceneName || sceneName,
      selected.version,
      selected.targetDurationHours,
      subscene,
    );
  });

  const doc = {
    schema_version: 'requirement_yaml_v0.1',
    requirement: {
      id: requirement.id,
      title: version.title,
      version: version.version,
      status: version.status,
      project_name: version.projectName,
      priority: version.priority,
      deadline: version.deadline,
      source_base_url: version.sourceBaseUrl || '',
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
        requested_scenes: version.requestedScenes.map((sceneName) => ({
          scene_name: sceneName,
          linked_scenario_ids: version.selectedSubscenes
            .filter((selected) => selected.sceneName === sceneName)
            .map((selected) => selected.subsceneCode),
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
    scenarios,
    traceability: {
      generated_from: `sop-requirement-manager ${new Date().toISOString()}`,
      requirement_id: requirement.id,
      requirement_version: version.version,
      subscene_versions: version.selectedSubscenes.map((selected) => ({
        scenario_id: selected.subsceneCode,
        version: selected.version,
      })),
    },
  };

  return YAML.stringify(doc, { lineWidth: 120 });
}
