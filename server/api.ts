import type {
  AppData,
  Customer,
  GlobalField,
  Material,
  MaterialStateRule,
  Requirement,
  RequirementAttachment,
  RequirementVersion,
  RobotModel,
  Scene,
  SubsceneVersion,
} from '../src/types';
import { buildRequirementYaml } from './yamlExport';
import { canEditStatus, createId, createShortId, nextPatchVersion, nowIso } from './versioning';

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
  createAttachmentUpload?(input: AttachmentUploadInput): Promise<AttachmentUploadSession>;
  uploadAttachmentPart?(input: AttachmentPartInput): Promise<AttachmentPartOutput>;
  completeAttachmentUpload?(input: AttachmentCompleteInput): Promise<void>;
  abortAttachmentUpload?(input: AttachmentAbortInput): Promise<void>;
  deleteAttachment?(storageKey: string): Promise<void>;
};

export type ApiRequest = {
  method: string;
  pathname: string;
  search?: string;
  body?: unknown;
  rawBody?: ArrayBuffer;
  authorization?: string | null;
  auth?: {
    password?: string;
    requireConfigured?: boolean;
  };
};

export type ApiResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export type AttachmentUploadInput = {
  storageKey: string;
  contentType: string;
};

export type AttachmentUploadSession = {
  uploadId: string;
  storageKey: string;
};

export type AttachmentPartInput = {
  storageKey: string;
  uploadId: string;
  partNumber: number;
  body: ArrayBuffer;
};

export type AttachmentPartOutput = {
  etag: string;
};

export type AttachmentCompleteInput = {
  storageKey: string;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
};

export type AttachmentAbortInput = {
  storageKey: string;
  uploadId: string;
};

const maxAttachmentSize = 1024 * 1024 * 1024;
const attachmentPartSize = 16 * 1024 * 1024;

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

function nextShortId(values: string[]): string {
  return createShortId(values);
}

function emptySubsceneVersion(patch: Partial<SubsceneVersion> = {}): SubsceneVersion {
  return {
    version: '0.0.1',
    status: 'draft',
    title: patch.title || '新的任务 SOP',
    description: patch.description || '',
    attachments: patch.attachments || [],
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
      acceptableOperations: [],
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

function attachmentStorageKey(scope: string, ownerId: string, version: string, attachmentId: string, fileName: string): string {
  const safeName = fileName.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 120) || 'attachment';
  return `${scope}/${ownerId}/${version}/${attachmentId}-${safeName}`;
}

function requireAttachmentStore(store: AppStore): asserts store is AppStore &
  Required<Pick<AppStore, 'createAttachmentUpload' | 'uploadAttachmentPart' | 'completeAttachmentUpload' | 'abortAttachmentUpload' | 'deleteAttachment'>> {
  if (
    !store.createAttachmentUpload ||
    !store.uploadAttachmentPart ||
    !store.completeAttachmentUpload ||
    !store.abortAttachmentUpload ||
    !store.deleteAttachment
  ) {
    throw new Error('附件存储未配置');
  }
}

function attachmentDownloadUrl(storageKey: string): string {
  return `/api/attachments/${encodeURIComponent(storageKey)}`;
}

function attachmentResponse(attachment: RequirementAttachment): RequirementAttachment & { url: string } {
  return { ...attachment, url: attachmentDownloadUrl(attachment.storageKey) };
}

function stripSelectedTaskSopCode(selected: RequirementVersion['selectedSubscenes'][number]): RequirementVersion['selectedSubscenes'][number] {
  const { subsceneCode: _subsceneCode, ...rest } = selected;
  return rest;
}

function stripTaskSopCodes(selectedSubscenes: RequirementVersion['selectedSubscenes'] = []): RequirementVersion['selectedSubscenes'] {
  return selectedSubscenes.map((selected, index) => {
    const stripped = stripSelectedTaskSopCode(selected);
    return {
      ...stripped,
      id: stripped.id || createId('pri'),
      title: stripped.title || stripped.subsceneName || stripped.taskSop?.title || `生产需求项 ${index + 1}`,
      description: stripped.description || '',
      sceneName: stripped.sceneName || stripped.taskSop?.sceneName || '',
      targetDurationHours: Number(stripped.targetDurationHours) || 0,
      targetCollectionCount: Number(stripped.targetCollectionCount) || 0,
    };
  });
}

function versionRank(value: string): number[] {
  return value.split('.').map((part) => Number.parseInt(part, 10) || 0);
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

function materialWithAttachment(material: Material, attachment: RequirementAttachment): Material {
  return { ...material, images: [...(material.images || []), attachment] };
}

function materialWithoutAttachment(material: Material, attachmentId: string): Material {
  return { ...material, images: (material.images || []).filter((attachment) => attachment.id !== attachmentId) };
}

function updateRequirementVersion(
  requirements: Requirement[],
  requirementId: string,
  versionNumber: string,
  updater: (version: RequirementVersion) => RequirementVersion,
): { nextRequirements: Requirement[]; version?: RequirementVersion; blocked?: ApiResponse } {
  const requirement = requirements.find((item) => item.id === requirementId);
  if (!requirement) return { nextRequirements: requirements, blocked: json(404, { message: '找不到客户需求' }) };
  const target = requirement.versions.find((version) => version.version === versionNumber);
  if (!target) return { nextRequirements: requirements, blocked: json(404, { message: '找不到客户需求版本' }) };
  if (target.status !== 'draft') return { nextRequirements: requirements, blocked: json(400, { message: '只能给草稿版本上传附件' }) };
  const nextVersion = updater(target);
  const nextRequirement = {
    ...requirement,
    versions: requirement.versions.map((version) => (version.version === versionNumber ? nextVersion : version)),
  };
  return {
    nextRequirements: requirements.map((item) => (item.id === requirementId ? nextRequirement : item)),
    version: nextVersion,
  };
}

function findSelectedTaskSopVersion(data: AppData, selected: RequirementVersion['selectedSubscenes'][number]): SubsceneVersion | undefined {
  const requestedVersion = selected.taskSop?.version || selected.version;
  const requestedSceneName = selected.taskSop?.sceneName || selected.sceneName;
  const requestedTitle = selected.taskSop?.title || selected.subsceneName;
  if (!requestedVersion || !requestedTitle) return undefined;

  if (selected.subsceneCode) {
    const foundByCode = data.scenes
      .flatMap((scene) => scene.subscenes)
      .find((subscene) => subscene.code === selected.subsceneCode)
      ?.versions.find((subsceneVersion) => subsceneVersion.version === requestedVersion);
    if (foundByCode) return foundByCode;
  }

  for (const scene of data.scenes) {
    if (requestedSceneName && scene.name !== requestedSceneName) continue;
    for (const subscene of scene.subscenes) {
      const foundVersion = subscene.versions.find((subsceneVersion) => subsceneVersion.version === requestedVersion);
      if (!foundVersion) continue;
      if (subscene.name === requestedTitle || foundVersion.title === requestedTitle) {
        return foundVersion;
      }
    }
  }
  return undefined;
}

function unconfirmedTaskSopRefs(data: AppData, version: RequirementVersion): string[] {
  return version.selectedSubscenes.flatMap((selected) => {
    const productionItemTitle = selected.title || selected.subsceneName || selected.taskSop?.title || '未命名生产需求项';
    const taskSopTitle = selected.taskSop?.title || selected.subsceneName;
    const taskSopVersion = selected.taskSop?.version || selected.version;
    if (!taskSopTitle || !taskSopVersion) {
      return [`${productionItemTitle}（未选择任务 SOP）`];
    }
    const foundVersion = findSelectedTaskSopVersion(data, selected);
    if (foundVersion?.status === 'confirmed') return [];
    const status = foundVersion ? '草稿' : '未找到';
    return [`${productionItemTitle} / ${taskSopTitle} v${taskSopVersion}（${status}）`];
  });
}

function updateSubsceneVersion(
  scenes: Scene[],
  sceneId: string,
  subsceneCode: string,
  versionNumber: string,
  updater: (version: SubsceneVersion) => SubsceneVersion,
): { nextScenes: Scene[]; version?: SubsceneVersion; blocked?: ApiResponse } {
  const scene = scenes.find((item) => item.id === sceneId);
  if (!scene) return { nextScenes: scenes, blocked: json(404, { message: '找不到场景' }) };
  const subscene = scene.subscenes.find((item) => item.code === subsceneCode);
  if (!subscene) return { nextScenes: scenes, blocked: json(404, { message: '找不到任务 SOP' }) };
  const target = subscene.versions.find((version) => version.version === versionNumber);
  if (!target) return { nextScenes: scenes, blocked: json(404, { message: '找不到任务 SOP 版本' }) };
  if (target.status !== 'draft') return { nextScenes: scenes, blocked: json(400, { message: '只能给草稿版本上传附件' }) };
  const nextVersion = updater(target);
  return {
    nextScenes: scenes.map((item) =>
      item.id === sceneId
        ? {
            ...item,
            subscenes: item.subscenes.map((current) =>
              current.code === subsceneCode
                ? {
                    ...current,
                    versions: current.versions.map((version) => (version.version === versionNumber ? nextVersion : version)),
                  }
                : current,
            ),
          }
        : item,
    ),
    version: nextVersion,
  };
}

function addAttachmentToVersion(version: RequirementVersion | SubsceneVersion, attachment: RequirementAttachment) {
  return { ...version, attachments: [...(version.attachments || []), attachment], updatedAt: nowIso() };
}

function completeAttachmentInVersion(version: RequirementVersion | SubsceneVersion, attachmentId: string) {
  return {
    ...version,
    attachments: (version.attachments || []).map((attachment) =>
      attachment.id === attachmentId ? { ...attachment, uploadedAt: nowIso() } : attachment,
    ),
    updatedAt: nowIso(),
  };
}

function removeAttachmentFromVersion(version: RequirementVersion | SubsceneVersion, attachmentId: string) {
  return {
    ...version,
    attachments: (version.attachments || []).filter((attachment) => attachment.id !== attachmentId),
    updatedAt: nowIso(),
  };
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

    const materialImageInit = path.match(/^\/api\/materials\/([^/]+)\/images\/init$/);
    if (method === 'POST' && materialImageInit) {
      requireAttachmentStore(store);
      const data = await store.readData();
      const materialId = decodeURIComponent(materialImageInit[1]);
      const material = data.materials.find((item) => item.id === materialId);
      if (!material) return json(404, { message: '找不到物料' });
      const body = request.body as { fileName?: string; size?: number; contentType?: string };
      const fileName = body.fileName?.trim();
      const size = Number(body.size || 0);
      const contentType = body.contentType || 'application/octet-stream';
      if (!fileName) return json(400, { message: '图片名称不能为空' });
      if (!contentType.startsWith('image/')) return json(400, { message: '只能上传图片文件' });
      if (!Number.isFinite(size) || size <= 0) return json(400, { message: '图片大小无效' });
      if (size > maxAttachmentSize) return json(400, { message: '单张图片不能超过 1G' });

      const attachmentId = createId('img');
      const storageKey = attachmentStorageKey('materials', materialId, 'images', attachmentId, fileName);
      const attachment: RequirementAttachment = {
        id: attachmentId,
        name: fileName,
        size,
        contentType,
        storageKey,
        uploadedAt: nowIso(),
      };
      const session = await store.createAttachmentUpload({ storageKey, contentType });
      const nextMaterials = data.materials.map((item) => (item.id === materialId ? materialWithAttachment(item, attachment) : item));
      await store.writeMaterials(nextMaterials);
      return json(200, {
        attachmentId,
        uploadId: session.uploadId,
        storageKey: session.storageKey,
        partSize: attachmentPartSize,
        maxSize: maxAttachmentSize,
      });
    }

    const materialImagePart = path.match(/^\/api\/materials\/([^/]+)\/images\/([^/]+)\/parts\/(\d+)$/);
    if (method === 'PUT' && materialImagePart) {
      requireAttachmentStore(store);
      if (!request.rawBody) return json(400, { message: '缺少图片分片内容' });
      const uploadId = decodeURIComponent(materialImagePart[2]);
      const partNumber = Number(decodeURIComponent(materialImagePart[3]));
      const storageKey = new URLSearchParams(request.search || '').get('storageKey') || '';
      if (!storageKey || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) return json(400, { message: '分片参数无效' });
      const result = await store.uploadAttachmentPart({ storageKey, uploadId, partNumber, body: request.rawBody });
      return json(200, result);
    }

    const materialImageComplete = path.match(/^\/api\/materials\/([^/]+)\/images\/([^/]+)\/complete$/);
    if (method === 'POST' && materialImageComplete) {
      requireAttachmentStore(store);
      const [materialId, attachmentId] = materialImageComplete.slice(1).map(decodeURIComponent);
      const body = request.body as { uploadId?: string; storageKey?: string; parts?: Array<{ partNumber: number; etag: string }> };
      if (!body.uploadId || !body.storageKey || !body.parts?.length) return json(400, { message: '图片完成参数无效' });
      await store.completeAttachmentUpload({ storageKey: body.storageKey, uploadId: body.uploadId, parts: body.parts });
      const data = await store.readData();
      const material = data.materials.find((item) => item.id === materialId);
      const attachment = material?.images?.find((item) => item.id === attachmentId);
      return json(200, attachment ? attachmentResponse(attachment) : { id: attachmentId });
    }

    const materialImageAbort = path.match(/^\/api\/materials\/([^/]+)\/images\/([^/]+)\/abort$/);
    if (method === 'POST' && materialImageAbort) {
      requireAttachmentStore(store);
      const [materialId, attachmentId] = materialImageAbort.slice(1).map(decodeURIComponent);
      const body = request.body as { uploadId?: string; storageKey?: string };
      if (body.uploadId && body.storageKey) {
        await store.abortAttachmentUpload({ storageKey: body.storageKey, uploadId: body.uploadId });
      }
      const data = await store.readData();
      const nextMaterials = data.materials.map((item) => (item.id === materialId ? materialWithoutAttachment(item, attachmentId) : item));
      await store.writeMaterials(nextMaterials);
      return json(200, { ok: true });
    }

    const materialImageDelete = path.match(/^\/api\/materials\/([^/]+)\/images\/([^/]+)$/);
    if (method === 'DELETE' && materialImageDelete) {
      requireAttachmentStore(store);
      const [materialId, attachmentId] = materialImageDelete.slice(1).map(decodeURIComponent);
      const data = await store.readData();
      const material = data.materials.find((item) => item.id === materialId);
      const attachment = material?.images?.find((item) => item.id === attachmentId);
      if (!attachment) return json(404, { message: '找不到图片' });
      await store.deleteAttachment(attachment.storageKey);
      const nextMaterials = data.materials.map((item) => (item.id === materialId ? materialWithoutAttachment(item, attachmentId) : item));
      return json(200, await store.writeMaterials(nextMaterials));
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
      const requirementId = nextShortId(data.requirements.map((item) => item.id));
      const requirement: Requirement = {
        id: requirementId,
        versions: [
          {
            version: '0.0.1',
            versionId: requirementVersionId(requirementId, '0.0.1'),
            parentVersionId: '',
            status: 'draft',
            title: body.title || '未命名客户需求',
            projectName: body.projectName || '',
            priority: body.priority || 'P2',
            deadline: body.deadline || '',
            sourceBaseUrl: body.sourceBaseUrl || '',
            attachmentNotes: body.attachmentNotes || '',
            attachments: body.attachments || [],
            extraTopicRequirementsText: body.extraTopicRequirementsText || '',
            globalRandomizationRequirements: body.globalRandomizationRequirements || '',
            additionalNotes: body.additionalNotes || '',
            customerId: body.customerId || data.customers[0]?.id || '',
            robotModelId: body.robotModelId || data.robotModels[0]?.id || '',
            businessGoal: body.businessGoal || '',
            requestedScenes: body.requestedScenes || [],
            requiredDurationHours: body.requiredDurationHours || 0,
            allowedOperations: body.allowedOperations || [],
            acceptableOperations: body.acceptableOperations || [],
            forbiddenOperations: body.forbiddenOperations || [],
            annotation: body.annotation || { required: true, types: [], allowedOperations: [], forbiddenOperations: [] },
            qualityInspection: body.qualityInspection || { required: true, samplingPolicy: '全量抽检' },
            delivery: body.delivery || {
              formats: ['mcap', 'json'],
              method: '',
              languages: [{ code: 'zh-CN', name: '简体中文' }],
              dataStructureUrl: '',
            },
            selectedSubscenes: stripTaskSopCodes(body.selectedSubscenes || []),
            updatedAt: nowIso(),
          },
        ],
      };
      return json(200, await store.writeRequirements([...data.requirements, requirement]));
    }

    const attachmentInit = path.match(/^\/api\/requirements\/([^/]+)\/versions\/([^/]+)\/attachments\/init$/);
    if (method === 'POST' && attachmentInit) {
      requireAttachmentStore(store);
      const data = await store.readData();
      const [requirementId, versionNumber] = [decodeURIComponent(attachmentInit[1]), decodeURIComponent(attachmentInit[2])];
      const body = request.body as { fileName?: string; size?: number; contentType?: string };
      const fileName = body.fileName?.trim();
      const size = Number(body.size || 0);
      if (!fileName) return json(400, { message: '附件名称不能为空' });
      if (!Number.isFinite(size) || size <= 0) return json(400, { message: '附件大小无效' });
      if (size > maxAttachmentSize) return json(400, { message: '单个附件不能超过 1G' });

      const attachmentId = createId('att');
      const storageKey = attachmentStorageKey('requirements', requirementId, versionNumber, attachmentId, fileName);
      const update = updateRequirementVersion(data.requirements, requirementId, versionNumber, (version) => {
        const attachment: RequirementAttachment = {
          id: attachmentId,
          name: fileName,
          size,
          contentType: body.contentType || 'application/octet-stream',
          storageKey,
          uploadedAt: nowIso(),
        };
        return addAttachmentToVersion(version, attachment) as RequirementVersion;
      });
      if (update.blocked) return update.blocked;
      const session = await store.createAttachmentUpload({ storageKey, contentType: body.contentType || 'application/octet-stream' });
      await store.writeRequirements(update.nextRequirements);
      return json(200, {
        attachmentId,
        uploadId: session.uploadId,
        storageKey: session.storageKey,
        partSize: attachmentPartSize,
        maxSize: maxAttachmentSize,
      });
    }

    const attachmentPart = path.match(/^\/api\/requirements\/([^/]+)\/versions\/([^/]+)\/attachments\/([^/]+)\/parts\/(\d+)$/);
    if (method === 'PUT' && attachmentPart) {
      requireAttachmentStore(store);
      if (!request.rawBody) return json(400, { message: '缺少附件分片内容' });
      const [_requirementId, _versionNumber, uploadId, partNumberText] = attachmentPart.slice(1).map(decodeURIComponent);
      const storageKey = new URLSearchParams(request.search || '').get('storageKey') || '';
      const partNumber = Number(partNumberText);
      if (!storageKey || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) return json(400, { message: '分片参数无效' });
      const result = await store.uploadAttachmentPart({ storageKey, uploadId, partNumber, body: request.rawBody });
      return json(200, result);
    }

    const attachmentComplete = path.match(/^\/api\/requirements\/([^/]+)\/versions\/([^/]+)\/attachments\/([^/]+)\/complete$/);
    if (method === 'POST' && attachmentComplete) {
      requireAttachmentStore(store);
      const [requirementId, versionNumber, attachmentId] = attachmentComplete.slice(1).map(decodeURIComponent);
      const body = request.body as { uploadId?: string; storageKey?: string; parts?: Array<{ partNumber: number; etag: string }> };
      if (!body.uploadId || !body.storageKey || !body.parts?.length) return json(400, { message: '附件完成参数无效' });
      await store.completeAttachmentUpload({ storageKey: body.storageKey, uploadId: body.uploadId, parts: body.parts });
      const data = await store.readData();
      const update = updateRequirementVersion(
        data.requirements,
        requirementId,
        versionNumber,
        (version) => completeAttachmentInVersion(version, attachmentId) as RequirementVersion,
      );
      if (update.blocked) return update.blocked;
      await store.writeRequirements(update.nextRequirements);
      const attachment = update.version?.attachments?.find((item) => item.id === attachmentId);
      return json(200, attachment ? attachmentResponse(attachment) : { id: attachmentId });
    }

    const attachmentAbort = path.match(/^\/api\/requirements\/([^/]+)\/versions\/([^/]+)\/attachments\/([^/]+)\/abort$/);
    if (method === 'POST' && attachmentAbort) {
      requireAttachmentStore(store);
      const [requirementId, versionNumber, attachmentId] = attachmentAbort.slice(1).map(decodeURIComponent);
      const body = request.body as { uploadId?: string; storageKey?: string };
      if (body.uploadId && body.storageKey) {
        await store.abortAttachmentUpload({ storageKey: body.storageKey, uploadId: body.uploadId });
      }
      const data = await store.readData();
      const update = updateRequirementVersion(
        data.requirements,
        requirementId,
        versionNumber,
        (version) => removeAttachmentFromVersion(version, attachmentId) as RequirementVersion,
      );
      if (update.blocked) return update.blocked;
      await store.writeRequirements(update.nextRequirements);
      return json(200, { ok: true });
    }

    const attachmentDelete = path.match(/^\/api\/requirements\/([^/]+)\/versions\/([^/]+)\/attachments\/([^/]+)$/);
    if (method === 'DELETE' && attachmentDelete) {
      requireAttachmentStore(store);
      const [requirementId, versionNumber, attachmentId] = attachmentDelete.slice(1).map(decodeURIComponent);
      const data = await store.readData();
      const requirement = data.requirements.find((item) => item.id === requirementId);
      const version = requirement?.versions.find((item) => item.version === versionNumber);
      const attachment = version?.attachments?.find((item) => item.id === attachmentId);
      if (!attachment) return json(404, { message: '找不到附件' });
      await store.deleteAttachment(attachment.storageKey);
      const update = updateRequirementVersion(
        data.requirements,
        requirementId,
        versionNumber,
        (current) => removeAttachmentFromVersion(current, attachmentId) as RequirementVersion,
      );
      if (update.blocked) return update.blocked;
      return json(200, await store.writeRequirements(update.nextRequirements));
    }

    const subsceneAttachmentInit = path.match(
      /^\/api\/scenes\/([^/]+)\/subscenes\/([^/]+)\/versions\/([^/]+)\/attachments\/init$/,
    );
    if (method === 'POST' && subsceneAttachmentInit) {
      requireAttachmentStore(store);
      const data = await store.readData();
      const [sceneId, subsceneCode, versionNumber] = subsceneAttachmentInit.slice(1).map(decodeURIComponent);
      const body = request.body as { fileName?: string; size?: number; contentType?: string };
      const fileName = body.fileName?.trim();
      const size = Number(body.size || 0);
      if (!fileName) return json(400, { message: '附件名称不能为空' });
      if (!Number.isFinite(size) || size <= 0) return json(400, { message: '附件大小无效' });
      if (size > maxAttachmentSize) return json(400, { message: '单个附件不能超过 1G' });

      const attachmentId = createId('att');
      const storageKey = attachmentStorageKey('subscenes', `${sceneId}/${subsceneCode}`, versionNumber, attachmentId, fileName);
      const attachment: RequirementAttachment = {
        id: attachmentId,
        name: fileName,
        size,
        contentType: body.contentType || 'application/octet-stream',
        storageKey,
        uploadedAt: nowIso(),
      };
      const update = updateSubsceneVersion(
        data.scenes,
        sceneId,
        subsceneCode,
        versionNumber,
        (version) => addAttachmentToVersion(version, attachment) as SubsceneVersion,
      );
      if (update.blocked) return update.blocked;
      const session = await store.createAttachmentUpload({ storageKey, contentType: body.contentType || 'application/octet-stream' });
      await store.writeScenes(update.nextScenes);
      return json(200, {
        attachmentId,
        uploadId: session.uploadId,
        storageKey: session.storageKey,
        partSize: attachmentPartSize,
        maxSize: maxAttachmentSize,
      });
    }

    const subsceneAttachmentPart = path.match(
      /^\/api\/scenes\/([^/]+)\/subscenes\/([^/]+)\/versions\/([^/]+)\/attachments\/([^/]+)\/parts\/(\d+)$/,
    );
    if (method === 'PUT' && subsceneAttachmentPart) {
      requireAttachmentStore(store);
      if (!request.rawBody) return json(400, { message: '缺少附件分片内容' });
      const uploadId = decodeURIComponent(subsceneAttachmentPart[4]);
      const partNumber = Number(decodeURIComponent(subsceneAttachmentPart[5]));
      const storageKey = new URLSearchParams(request.search || '').get('storageKey') || '';
      if (!storageKey || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) return json(400, { message: '分片参数无效' });
      const result = await store.uploadAttachmentPart({ storageKey, uploadId, partNumber, body: request.rawBody });
      return json(200, result);
    }

    const subsceneAttachmentComplete = path.match(
      /^\/api\/scenes\/([^/]+)\/subscenes\/([^/]+)\/versions\/([^/]+)\/attachments\/([^/]+)\/complete$/,
    );
    if (method === 'POST' && subsceneAttachmentComplete) {
      requireAttachmentStore(store);
      const [sceneId, subsceneCode, versionNumber, attachmentId] = subsceneAttachmentComplete.slice(1).map(decodeURIComponent);
      const body = request.body as { uploadId?: string; storageKey?: string; parts?: Array<{ partNumber: number; etag: string }> };
      if (!body.uploadId || !body.storageKey || !body.parts?.length) return json(400, { message: '附件完成参数无效' });
      await store.completeAttachmentUpload({ storageKey: body.storageKey, uploadId: body.uploadId, parts: body.parts });
      const data = await store.readData();
      const update = updateSubsceneVersion(
        data.scenes,
        sceneId,
        subsceneCode,
        versionNumber,
        (version) => completeAttachmentInVersion(version, attachmentId) as SubsceneVersion,
      );
      if (update.blocked) return update.blocked;
      await store.writeScenes(update.nextScenes);
      const attachment = update.version?.attachments?.find((item) => item.id === attachmentId);
      return json(200, attachment ? attachmentResponse(attachment) : { id: attachmentId });
    }

    const subsceneAttachmentAbort = path.match(
      /^\/api\/scenes\/([^/]+)\/subscenes\/([^/]+)\/versions\/([^/]+)\/attachments\/([^/]+)\/abort$/,
    );
    if (method === 'POST' && subsceneAttachmentAbort) {
      requireAttachmentStore(store);
      const [sceneId, subsceneCode, versionNumber, attachmentId] = subsceneAttachmentAbort.slice(1).map(decodeURIComponent);
      const body = request.body as { uploadId?: string; storageKey?: string };
      if (body.uploadId && body.storageKey) {
        await store.abortAttachmentUpload({ storageKey: body.storageKey, uploadId: body.uploadId });
      }
      const data = await store.readData();
      const update = updateSubsceneVersion(
        data.scenes,
        sceneId,
        subsceneCode,
        versionNumber,
        (version) => removeAttachmentFromVersion(version, attachmentId) as SubsceneVersion,
      );
      if (update.blocked) return update.blocked;
      await store.writeScenes(update.nextScenes);
      return json(200, { ok: true });
    }

    const subsceneAttachmentDelete = path.match(
      /^\/api\/scenes\/([^/]+)\/subscenes\/([^/]+)\/versions\/([^/]+)\/attachments\/([^/]+)$/,
    );
    if (method === 'DELETE' && subsceneAttachmentDelete) {
      requireAttachmentStore(store);
      const [sceneId, subsceneCode, versionNumber, attachmentId] = subsceneAttachmentDelete.slice(1).map(decodeURIComponent);
      const data = await store.readData();
      const scene = data.scenes.find((item) => item.id === sceneId);
      const version = scene?.subscenes
        .find((item) => item.code === subsceneCode)
        ?.versions.find((item) => item.version === versionNumber);
      const attachment = version?.attachments?.find((item) => item.id === attachmentId);
      if (!attachment) return json(404, { message: '找不到附件' });
      await store.deleteAttachment(attachment.storageKey);
      const update = updateSubsceneVersion(
        data.scenes,
        sceneId,
        subsceneCode,
        versionNumber,
        (current) => removeAttachmentFromVersion(current, attachmentId) as SubsceneVersion,
      );
      if (update.blocked) return update.blocked;
      return json(200, await store.writeScenes(update.nextScenes));
    }

    const requirementUpdate = path.match(/^\/api\/requirements\/([^/]+)$/);
    if (method === 'PUT' && requirementUpdate) {
      const data = await store.readData();
      const requirement = data.requirements.find((item) => item.id === requirementUpdate[1]);
      if (!requirement) return json(404, { message: '找不到客户需求' });
      const { baseVersion, ...patch } = request.body as Partial<RequirementVersion> & { baseVersion?: string };
      const normalizedPatch = {
        ...patch,
        ...(patch.selectedSubscenes ? { selectedSubscenes: stripTaskSopCodes(patch.selectedSubscenes) } : {}),
      };
      const current = findTargetVersion(requirement.versions, baseVersion);
      const editable = canEditStatus(current.status);
      const nextVersionNumber = editable ? current.version : nextAvailablePatchVersion(requirement.versions, current.version);
      const nextVersion: RequirementVersion = {
        ...current,
        ...normalizedPatch,
        selectedSubscenes: stripTaskSopCodes(normalizedPatch.selectedSubscenes || current.selectedSubscenes),
        version: nextVersionNumber,
        versionId: requirementVersionId(requirement.id, nextVersionNumber),
        parentVersionId: editable
          ? current.parentVersionId || requirementParentVersionId(requirement, nextVersionNumber)
          : requirementVersionId(requirement.id, current.version),
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
      const requirement = data.requirements.find((item) => item.id === requirementConfirm[1]);
      if (!requirement) return json(404, { message: '找不到客户需求' });
      const targetVersion = (request.body as { version?: string })?.version;
      const versionToConfirm = targetVersion || latestVersion(requirement.versions).version;
      const target = requirement.versions.find((version) => version.version === versionToConfirm);
      if (!target) return json(404, { message: '找不到客户需求版本' });
      const blockedTaskSops = unconfirmedTaskSopRefs(data, target);
      if (blockedTaskSops.length > 0) {
        return json(400, { message: `有任务 SOP 还没有确认，不能确认需求：${blockedTaskSops.join('；')}` });
      }
      const nextRequirement = {
        ...requirement,
        versions: requirement.versions.map((version) =>
          version.version === versionToConfirm
            ? {
                ...version,
                selectedSubscenes: stripTaskSopCodes(version.selectedSubscenes),
                versionId: version.versionId || requirementVersionId(requirement.id, version.version),
                parentVersionId: version.parentVersionId || requirementParentVersionId(requirement, version.version),
                status: 'confirmed' as const,
                updatedAt: nowIso(),
              }
            : version,
        ),
      };
      const next = data.requirements.map((item) => (item.id === requirement.id ? nextRequirement : item));
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
      if (!foundSubscene) return json(404, { message: '找不到任务 SOP' });
      if (!foundVersion) return json(404, { message: '找不到任务 SOP 版本' });
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
