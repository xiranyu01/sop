import YAML from 'yaml';
import type {
  AppData,
  ObjectInitialState,
  ObjectTargetState,
  Requirement,
  RequirementVersion,
  RequestedSubscene,
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

function findTaskSopVersion(data: AppData, selected: RequestedSubscene): { sceneName: string; taskSopName: string; subscene: SubsceneVersion } {
  if (selected.subsceneCode) {
    for (const scene of data.scenes) {
      const subscene = scene.subscenes.find((item) => item.code === selected.subsceneCode);
      const versionItem = subscene?.versions.find((item) => item.version === selected.version);
      if (versionItem) {
        return { sceneName: selected.sceneName || scene.name, taskSopName: selected.subsceneName || versionItem.title || subscene?.name || '', subscene: versionItem };
      }
    }
  }

  for (const scene of data.scenes) {
    if (selected.sceneName && scene.name !== selected.sceneName) continue;
    for (const subscene of scene.subscenes) {
      const versionItem = subscene.versions.find((item) => item.version === selected.version);
      if (!versionItem) continue;
      if (subscene.name === selected.subsceneName || versionItem.title === selected.subsceneName) {
        return { sceneName: scene.name, taskSopName: selected.subsceneName || versionItem.title || subscene.name, subscene: versionItem };
      }
    }
  }

  throw new Error(`找不到任务 SOP ${selected.sceneName} / ${selected.subsceneName} 的版本 ${selected.version}`);
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
    uploaded_at: attachment.uploadedAt,
  }));
}

function mapExampleImages(ids: string[] | undefined, attachments: SubsceneVersion['attachments']): unknown {
  return (ids || []).map((id) => {
    const attachment = attachments?.find((item) => item.id === id);
    return {
      attachment_id: id,
      name: attachment?.name || '',
    };
  });
}

function mapObjectStates(
  states: {
    initial: ObjectInitialState[];
    target: ObjectTargetState[];
  },
  attachments: SubsceneVersion['attachments'],
): unknown {
  return {
    initial: states.initial.map((state) => ({
      object: state.object,
      allowed_locations: state.allowedLocations.map((location) => ({
        ...omitKeys(toSnakeRecord(location), ['example_image_attachment_ids']),
        example_images: mapExampleImages(location.exampleImageAttachmentIds, attachments),
      })),
    })),
    target: states.target.map((state) => ({
      ...omitKeys(toSnakeRecord(state), ['example_image_attachment_ids']),
      example_images: mapExampleImages(state.exampleImageAttachmentIds, attachments),
    })),
  };
}

function mapRandomization(randomization: SubsceneVersion['randomization'], attachments?: SubsceneVersion['attachments']): unknown {
  const mapped = toSnakeObject(omitKeys(randomization, ['material' + 'StateDuringOperation'])) as Record<string, unknown>;
  const materialInitialState = mapped.material_initial_state as { rules?: Array<Record<string, unknown>> } | undefined;
  if (materialInitialState?.rules) {
    materialInitialState.rules = materialInitialState.rules.map((rule, index) => {
      const source = randomization.materialInitialState.rules[index];
      return {
        ...omitKeys(rule, ['example_image_attachment_ids']),
        example_images: mapExampleImages(source?.exampleImageAttachmentIds, attachments),
      };
    });
  }
  return mapped;
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
  sceneName: string,
  taskSopName: string,
  requestedVersion: string,
  targetDurationHours: number,
  targetCollectionCount: number | undefined,
  subscene: SubsceneVersion,
): unknown {
  return {
    version: requestedVersion,
    scene_name: sceneName,
    task_sop_name: taskSopName || subscene.title || subscene.description,
    description: subscene.description,
    attachments: mapAttachments(subscene.attachments),
    target_duration_hours: targetDurationHours,
    target_collection_count: targetCollectionCount || 0,
    materials: mapMaterials(subscene.materials),
    robot_state: toSnakeObject(subscene.robotState),
    randomization: mapRandomization(subscene.randomization, subscene.attachments),
    operation: mapOperation(subscene.operation),
    object_states: mapObjectStates(subscene.objectStates, subscene.attachments),
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
    const { sceneName, taskSopName, subscene } = findTaskSopVersion(data, selected);
    return mapScenario(
      selected.sceneName || sceneName,
      selected.subsceneName || taskSopName,
      selected.version,
      selected.targetDurationHours,
      selected.targetCollectionCount,
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
          task_sops: version.selectedSubscenes
            .filter((selected) => selected.sceneName === sceneName)
            .map((selected) => ({
              task_sop_name: selected.subsceneName,
              version: selected.version,
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
    scenarios,
    traceability: {
      generated_from: `sop-requirement-manager ${new Date().toISOString()}`,
      requirement_id: requirement.id,
      requirement_version: version.version,
      task_sop_versions: version.selectedSubscenes.map((selected) => ({
        scene_name: selected.sceneName,
        task_sop_name: selected.subsceneName,
        version: selected.version,
      })),
    },
  };

  return YAML.stringify(doc, { lineWidth: 120 });
}
