import type {
  AppData,
  Customer,
  GlobalField,
  Material,
  MaterialStateRule,
  Requirement,
  RequirementVersion,
  RobotModel,
  Scene,
  SubsceneVersion,
} from '../src/types';
import { buildRequirementYaml } from './yamlExport';
import { canEditStatus, createId, nextPatchVersion, nowIso } from './versioning';

export type AppStore = {
  readData(): Promise<AppData>;
  writeCustomers(customers: Customer[]): Promise<Customer[]>;
  writeMaterials(materials: Material[]): Promise<Material[]>;
  writeRobotModels(robotModels: RobotModel[]): Promise<RobotModel[]>;
  writeScenes(scenes: Scene[]): Promise<Scene[]>;
  writeRequirements(requirements: Requirement[]): Promise<Requirement[]>;
  writeGlobalFields(globalFields: GlobalField[]): Promise<GlobalField[]>;
  writeMaterialStateRules(materialStateRules: MaterialStateRule[]): Promise<MaterialStateRule[]>;
  writeExport(requirementId: string, version: string, yaml: string): Promise<string>;
};

export type ApiRequest = {
  method: string;
  pathname: string;
  body?: unknown;
  authorization?: string | null;
  auth?: {
    password?: string;
    requireConfigured?: boolean;
  };
};

export type ApiResponse = {
  status: number;
  body: unknown;
};

function latestVersion<T extends { version: string }>(versions: T[]): T {
  if (versions.length === 0) {
    throw new Error('版本列表为空');
  }
  return versions[versions.length - 1];
}

function findTargetVersion<T extends { version: string }>(versions: T[], targetVersion?: string): T {
  if (!targetVersion) {
    return latestVersion(versions);
  }
  const found = versions.find((version) => version.version === targetVersion);
  if (!found) {
    throw new Error(`找不到版本 ${targetVersion}`);
  }
  return found;
}

function nextAvailablePatchVersion<T extends { version: string }>(versions: T[], baseVersion: string): string {
  const usedVersions = new Set(versions.map((version) => version.version));
  let candidate = nextPatchVersion(baseVersion);
  while (usedVersions.has(candidate)) {
    candidate = nextPatchVersion(candidate);
  }
  return candidate;
}

function normalizeError(error: unknown): { message: string } {
  return { message: error instanceof Error ? error.message : '未知错误' };
}

function replaceById<T extends { id: string }>(collection: T[], item: T): T[] {
  return collection.some((current) => current.id === item.id)
    ? collection.map((current) => (current.id === item.id ? item : current))
    : [...collection, item];
}

function nextReadableId(values: string[], prefix: string): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`, 'i');
  const maxNumber = values.reduce((max, value) => {
    const match = value.match(pattern);
    if (!match) return max;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isNaN(parsed) ? max : Math.max(max, parsed);
  }, 0);
  return `${prefix}${maxNumber + 1}`;
}

function emptySubsceneVersion(patch: Partial<SubsceneVersion> = {}): SubsceneVersion {
  return {
    version: '0.0.1',
    status: 'draft',
    title: patch.title || '新的子场景',
    description: patch.description || '',
    materials: patch.materials || [],
    robotState: patch.robotState || { initial: '', target: '' },
    robotOperationRequirements: patch.robotOperationRequirements || '',
    robotInitialRandomizationRequirements: patch.robotInitialRandomizationRequirements || [],
    randomizationFrequency: patch.randomizationFrequency || '1',
    randomization: patch.randomization || {
      robotInitialState: {
        enabled: true,
        changeFrequency: 'every_n_records',
        changeIntervalRecords: 1,
        randomizedFields: [],
      },
      materialInitialState: { rules: [] },
    },
    operation: patch.operation || {
      stepOrder: '',
      steps: [],
      stepRandomization: { enabled: false, startOrder: 1, endOrder: 1 },
      allowedOperations: [],
      forbiddenOperations: [],
    },
    objectStates: patch.objectStates || { initial: [], target: [] },
    materialStateRules: patch.materialStateRules || [],
    annotation: patch.annotation || {
      status: 'pending',
      note: '',
      actionTags: [],
      steps: [],
      allowedOperations: [],
      forbiddenOperations: [],
      stepRandomization: { enabled: false, startOrder: 1, endOrder: 1 },
    },
    references: patch.references || { recordUrls: [], attachments: [] },
    updatedAt: nowIso(),
    ...patch,
  };
}

function json(status: number, body: unknown): ApiResponse {
  return { status, body };
}

function assertAuthorized(request: ApiRequest): ApiResponse | undefined {
  const password = request.auth?.password;
  if (request.auth?.requireConfigured && !password) {
    return json(500, { message: '服务端未配置 APP_PASSWORD' });
  }
  if (!password) {
    return undefined;
  }
  if (request.authorization !== `Bearer ${password}`) {
    return json(401, { message: '访问密码无效或已过期' });
  }
  return undefined;
}

export async function handleApiRequest(store: AppStore, request: ApiRequest): Promise<ApiResponse> {
  const authError = assertAuthorized(request);
  if (authError) return authError;

  try {
    const path = request.pathname.replace(/\/$/, '');
    const method = request.method.toUpperCase();

    if (method === 'GET' && path === '/api/data') {
      return json(200, await store.readData());
    }

    if (method === 'POST' && path === '/api/customers') {
      const data = await store.readData();
      const item = { ...(request.body as Partial<Customer>), id: (request.body as Partial<Customer>)?.id || createId('cus') } as Customer;
      return json(200, await store.writeCustomers(replaceById(data.customers, item)));
    }

    if (method === 'POST' && path === '/api/materials') {
      const data = await store.readData();
      const body = request.body as Partial<Material>;
      const item = {
        ...body,
        id: body.id || createId('mat'),
        skuId: body.skuId || nextReadableId(data.materials.map((material) => material.skuId), 'SKU'),
      } as Material;
      const duplicated = data.materials.some((material) => material.id !== item.id && material.skuId === item.skuId);
      if (duplicated) return json(400, { message: `SKU 编号 ${item.skuId} 已存在` });
      return json(200, await store.writeMaterials(replaceById(data.materials, item)));
    }

    if (method === 'POST' && path === '/api/robot-models') {
      const data = await store.readData();
      const item = { ...(request.body as Partial<RobotModel>), id: (request.body as Partial<RobotModel>)?.id || createId('robot') } as RobotModel;
      return json(200, await store.writeRobotModels(replaceById(data.robotModels, item)));
    }

    if (method === 'POST' && path === '/api/global-fields') {
      const data = await store.readData();
      const body = request.body as Partial<GlobalField>;
      const item = {
        ...body,
        id: body.id || createId('field'),
        status: body.status || 'active',
        updatedAt: nowIso(),
      } as GlobalField;
      return json(200, await store.writeGlobalFields(replaceById(data.globalFields, item)));
    }

    if (method === 'POST' && path === '/api/material-state-rules') {
      const data = await store.readData();
      const body = request.body as Partial<MaterialStateRule>;
      const item = {
        ...body,
        id: body.id || createId('state_rule'),
        updatedAt: nowIso(),
      } as MaterialStateRule;
      return json(200, await store.writeMaterialStateRules(replaceById(data.materialStateRules, item)));
    }

    if (method === 'POST' && path === '/api/scenes') {
      const data = await store.readData();
      const item = { ...(request.body as Partial<Scene>), id: (request.body as Partial<Scene>)?.id || createId('scene') } as Scene;
      return json(200, await store.writeScenes(replaceById(data.scenes, item)));
    }

    if (method === 'POST' && path === '/api/requirements') {
      const data = await store.readData();
      const body = request.body as Partial<RequirementVersion>;
      const requirement: Requirement = {
        id: nextReadableId(data.requirements.map((item) => item.id), 'R'),
        versions: [
          {
            version: '0.0.1',
            status: 'draft',
            title: body.title || '未命名客户需求',
            projectName: body.projectName || '',
            priority: body.priority || 'P2',
            deadline: body.deadline || '',
            sourceBaseUrl: body.sourceBaseUrl || '',
            attachmentNotes: body.attachmentNotes || '',
            extraTopicRequirementsText: body.extraTopicRequirementsText || '',
            globalRandomizationRequirements: body.globalRandomizationRequirements || '',
            additionalNotes: body.additionalNotes || '',
            customerId: body.customerId || data.customers[0]?.id || '',
            robotModelId: body.robotModelId || data.robotModels[0]?.id || '',
            businessGoal: body.businessGoal || '',
            requestedScenes: body.requestedScenes || [],
            requiredDurationHours: body.requiredDurationHours || 0,
            allowedOperations: body.allowedOperations || [],
            forbiddenOperations: body.forbiddenOperations || [],
            annotation: body.annotation || { required: true, types: [], allowedOperations: [], forbiddenOperations: [] },
            qualityInspection: body.qualityInspection || { required: true, samplingPolicy: '全量抽检' },
            delivery: body.delivery || {
              formats: ['mcap', 'json'],
              method: '',
              languages: [{ code: 'zh-CN', name: '简体中文' }],
              dataStructureUrl: '',
            },
            selectedSubscenes: body.selectedSubscenes || [],
            updatedAt: nowIso(),
          },
        ],
      };
      return json(200, await store.writeRequirements([...data.requirements, requirement]));
    }

    const requirementUpdate = path.match(/^\/api\/requirements\/([^/]+)$/);
    if (method === 'PUT' && requirementUpdate) {
      const data = await store.readData();
      const requirement = data.requirements.find((item) => item.id === requirementUpdate[1]);
      if (!requirement) return json(404, { message: '找不到客户需求' });
      const { baseVersion, ...patch } = request.body as Partial<RequirementVersion> & { baseVersion?: string };
      const current = findTargetVersion(requirement.versions, baseVersion);
      const editable = canEditStatus(current.status);
      const nextVersion: RequirementVersion = {
        ...current,
        ...patch,
        version: editable ? current.version : nextAvailablePatchVersion(requirement.versions, current.version),
        status: editable ? current.status : 'draft',
        updatedAt: nowIso(),
      };
      const nextRequirement = {
        ...requirement,
        versions: editable
          ? requirement.versions.map((version) => (version.version === current.version ? nextVersion : version))
          : [...requirement.versions, nextVersion],
      };
      return json(200, await store.writeRequirements(data.requirements.map((item) => (item.id === requirement.id ? nextRequirement : item))));
    }

    const requirementDelete = path.match(/^\/api\/requirements\/([^/]+)\/versions\/([^/]+)$/);
    if (method === 'DELETE' && requirementDelete) {
      const data = await store.readData();
      const requirement = data.requirements.find((item) => item.id === requirementDelete[1]);
      if (!requirement) return json(404, { message: '找不到客户需求' });
      const target = requirement.versions.find((version) => version.version === requirementDelete[2]);
      if (!target) return json(404, { message: '找不到客户需求版本' });
      if (target.status !== 'draft') return json(400, { message: '只能删除草稿版本' });
      if (requirement.versions.length <= 1) return json(400, { message: '至少需要保留一个版本' });
      const nextRequirement = {
        ...requirement,
        versions: requirement.versions.filter((version) => version.version !== target.version),
      };
      return json(200, await store.writeRequirements(data.requirements.map((item) => (item.id === requirement.id ? nextRequirement : item))));
    }

    const requirementConfirm = path.match(/^\/api\/requirements\/([^/]+)\/confirm$/);
    if (method === 'POST' && requirementConfirm) {
      const data = await store.readData();
      const targetVersion = (request.body as { version?: string })?.version;
      const next = data.requirements.map((requirement) => {
        if (requirement.id !== requirementConfirm[1]) return requirement;
        const versionToConfirm = targetVersion || latestVersion(requirement.versions).version;
        return {
          ...requirement,
          versions: requirement.versions.map((version) =>
            version.version === versionToConfirm ? { ...version, status: 'confirmed' as const, updatedAt: nowIso() } : version,
          ),
        };
      });
      return json(200, await store.writeRequirements(next));
    }

    const subsceneSave = path.match(/^\/api\/scenes\/([^/]+)\/subscenes\/([^/]+)\/versions$/);
    if (method === 'POST' && subsceneSave) {
      const data = await store.readData();
      const [sceneId, subsceneCode] = [decodeURIComponent(subsceneSave[1]), decodeURIComponent(subsceneSave[2])];
      const nextScenes = data.scenes.map((scene) => {
        if (scene.id !== sceneId) return scene;
        const { baseVersion, ...patch } = request.body as Partial<SubsceneVersion> & { baseVersion?: string };
        const existing = scene.subscenes.find((subscene) => subscene.code === subsceneCode);
        if (!existing) {
          const created = emptySubsceneVersion(patch);
          return {
            ...scene,
            subscenes: [
              ...scene.subscenes,
              {
                code: subsceneCode,
                name: created.title || subsceneCode,
                versions: [created],
              },
            ],
          };
        }
        return {
          ...scene,
          subscenes: scene.subscenes.map((subscene) => {
            if (subscene.code !== subsceneCode) return subscene;
            const current = findTargetVersion(subscene.versions, baseVersion);
            const editable = canEditStatus(current.status);
            const canEditTitle = current.version === '0.0.1' && current.status === 'draft';
            const effectivePatch = canEditTitle ? patch : { ...patch, title: current.title };
            const nextVersion: SubsceneVersion = {
              ...current,
              ...effectivePatch,
              version: editable ? current.version : nextAvailablePatchVersion(subscene.versions, current.version),
              status: editable ? current.status : 'draft',
              updatedAt: nowIso(),
            };
            return {
              ...subscene,
              name: canEditTitle && patch.title ? patch.title : subscene.name,
              versions: editable
                ? subscene.versions.map((version) => (version.version === current.version ? nextVersion : version))
                : [...subscene.versions, nextVersion],
            };
          }),
        };
      });
      return json(200, await store.writeScenes(nextScenes));
    }

    const subsceneDelete = path.match(/^\/api\/scenes\/([^/]+)\/subscenes\/([^/]+)\/versions\/([^/]+)$/);
    if (method === 'DELETE' && subsceneDelete) {
      const data = await store.readData();
      const [sceneId, subsceneCode, targetVersion] = [
        decodeURIComponent(subsceneDelete[1]),
        decodeURIComponent(subsceneDelete[2]),
        decodeURIComponent(subsceneDelete[3]),
      ];
      let foundSubscene = false;
      let foundVersion = false;
      let blockedMessage = '';
      const nextScenes = data.scenes.map((scene) => {
        if (scene.id !== sceneId) return scene;
        return {
          ...scene,
          subscenes: scene.subscenes.map((subscene) => {
            if (subscene.code !== subsceneCode) return subscene;
            foundSubscene = true;
            const target = subscene.versions.find((version) => version.version === targetVersion);
            if (!target) return subscene;
            foundVersion = true;
            if (target.status !== 'draft') {
              blockedMessage = '只能删除草稿版本';
              return subscene;
            }
            if (subscene.versions.length <= 1) {
              blockedMessage = '至少需要保留一个版本';
              return subscene;
            }
            return {
              ...subscene,
              versions: subscene.versions.filter((version) => version.version !== target.version),
            };
          }),
        };
      });
      if (!foundSubscene) return json(404, { message: '找不到子场景' });
      if (!foundVersion) return json(404, { message: '找不到子场景版本' });
      if (blockedMessage) return json(400, { message: blockedMessage });
      return json(200, await store.writeScenes(nextScenes));
    }

    const subsceneConfirm = path.match(/^\/api\/scenes\/([^/]+)\/subscenes\/([^/]+)\/confirm$/);
    if (method === 'POST' && subsceneConfirm) {
      const data = await store.readData();
      const [sceneId, subsceneCode] = [decodeURIComponent(subsceneConfirm[1]), decodeURIComponent(subsceneConfirm[2])];
      const versionToConfirm = (request.body as { version?: string })?.version;
      const nextScenes = data.scenes.map((scene) => {
        if (scene.id !== sceneId) return scene;
        return {
          ...scene,
          subscenes: scene.subscenes.map((subscene) => {
            if (subscene.code !== subsceneCode) return subscene;
            const target = versionToConfirm || latestVersion(subscene.versions).version;
            return {
              ...subscene,
              versions: subscene.versions.map((version) =>
                version.version === target ? { ...version, status: 'confirmed' as const, updatedAt: nowIso() } : version,
              ),
            };
          }),
        };
      });
      return json(200, await store.writeScenes(nextScenes));
    }

    const exportYaml = path.match(/^\/api\/requirements\/([^/]+)\/export-yaml$/);
    if (method === 'POST' && exportYaml) {
      const data = await store.readData();
      const requirement = data.requirements.find((item) => item.id === exportYaml[1]);
      if (!requirement) return json(404, { message: '找不到客户需求' });
      const selectedVersion = (request.body as { version?: string })?.version
        ? requirement.versions.find((version) => version.version === (request.body as { version?: string }).version)
        : latestVersion(requirement.versions);
      if (!selectedVersion) return json(404, { message: '找不到客户需求版本' });
      const yaml = buildRequirementYaml(data, requirement, selectedVersion);
      const file = await store.writeExport(requirement.id, selectedVersion.version, yaml);
      return json(200, { yaml, path: file });
    }

    return json(404, { message: '接口不存在' });
  } catch (error) {
    return json(500, normalizeError(error));
  }
}
