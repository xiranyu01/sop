import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { defaultAppMetadata } from './schemaVersions';
import type {
  AppData,
  AttachmentUploadInit,
  AttachmentUploadPart,
  Customer,
  EntityStatus,
  ExportResult,
  GlobalField,
  GlobalFieldGroup,
  GlobalFieldStatus,
  Material,
  OperationStep,
  Requirement,
  RequirementAttachment,
  RequirementVersion,
  RobotModel,
  Scene,
  Subscene,
  SubsceneVersion,
  TextItem,
} from './types';

type Page = 'requirements' | 'scenes' | 'globalFields' | 'customers' | 'materials' | 'robots';

const pageStorageKey = 'sop-manager-current-page';
const authStorageKey = 'sop-manager-api-password';

type DataTableColumn<T> = {
  key: string;
  title: string;
  width?: string;
  align?: 'left' | 'center' | 'right';
  allowOverflow?: boolean;
  render: (item: T, index: number) => ReactNode;
};

type CandidateSubsceneOption = {
  sceneId: string;
  sceneName: string;
  code: string;
  name: string;
  versions: SubsceneVersion[];
  selectedVersion: SubsceneVersion;
};

type SubsceneLookupResult = {
  scene: Scene;
  subscene: Subscene;
  version?: SubsceneVersion;
};

type RequirementReturnTarget = {
  requirementId: string;
  version: string;
};

type VersionPatch<T> = Partial<T> & { baseVersion?: string };

type InitialLocationRow = {
  object: string;
  primaryReferences: string[];
  primaryRelativePositions: string[];
  supportSurfaces: string[];
  regions: string[];
  secondaryReferences: string[];
  secondaryRelativePositions: string[];
  poses: string[];
  forms: string[];
  parameters: string[];
  collectorInstruction: string;
  exampleImageAttachmentIds: string[];
  constraints: string[];
};

type TargetStateRow = InitialLocationRow;

type MaterialInitialRandomizationRow = {
  targetMaterials: string[];
  changeIntervalRecords: number;
  randomizedFields: string[];
  collectorInstruction: string;
  exampleImageAttachmentIds: string[];
  constraints: string;
};

type RobotInitialRandomizationRow = {
  target: string;
  changeIntervalRecords: number;
  randomizedFields: string[];
  constraints: string;
};

type Option = {
  value: string;
  label: string;
  category?: string;
  description?: string;
};

type AttachmentStorageStatus = {
  enabled: boolean;
  message: string;
  publicBaseUrl?: string;
};

type PrintableSection = {
  title: string;
  description?: string;
  content: string;
  attachments?: PrintableAttachment[];
};

type PrintableAttachment = {
  name: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  url?: string;
};

type StateImageUploadTarget =
  | { kind: 'initial'; index: number }
  | { kind: 'target'; index: number }
  | { kind: 'randomization'; index: number };

type PrintableReport = {
  title: string;
  subtitle?: string;
  fileName: string;
  sections: PrintableSection[];
};

const globalFieldGroupLabels: Record<GlobalFieldGroup, string> = {
  robot_state: '机器人状态',
  reference_object: '参照物',
  relative_position: '相对位置',
  support_surface: '支撑面',
  region: '区域',
  pose: '姿态',
  form: '形态',
  parameter: '参数',
  allowed_operation: '采集操作要求',
  acceptable_operation: '不完美但可接受的采集操作',
  forbidden_operation: '采集禁止操作',
  annotation_allowed_operation: '标注操作要求',
  annotation_forbidden_operation: '标注禁止操作',
  random_field: '随机字段',
  robot_random_field: '机器人随机性字段',
  material_random_field: '物料随机性字段',
  annotation_type: '标注类型',
  delivery_format: '交付格式',
  delivery_language: '交付语言',
  delivery_method: '交付方式',
  sampling_policy: '质检策略',
};

const hiddenGlobalFieldGroups: GlobalFieldGroup[] = ['random_field'];
const globalFieldGroups = (Object.keys(globalFieldGroupLabels) as GlobalFieldGroup[]).filter(
  (group) => !hiddenGlobalFieldGroups.includes(group),
);

type GlobalFieldCategory = {
  id: string;
  label: string;
  description: string;
  groups: GlobalFieldGroup[];
};

const globalFieldCategoryConfigs: GlobalFieldCategory[] = [
  {
    id: 'object_state',
    label: '对象状态',
    description: '位置、姿态、形态、参数',
    groups: ['reference_object', 'relative_position', 'support_surface', 'region', 'pose', 'form', 'parameter'],
  },
  {
    id: 'randomization',
    label: '随机性',
    description: '机器人与物料随机字段',
    groups: ['robot_random_field', 'material_random_field'],
  },
  {
    id: 'operation',
    label: '采集 / 标注操作',
    description: '操作要求、禁止操作',
    groups: [
      'allowed_operation',
      'acceptable_operation',
      'forbidden_operation',
      'annotation_allowed_operation',
      'annotation_forbidden_operation',
    ],
  },
  {
    id: 'delivery_quality',
    label: '交付 / 质检',
    description: '格式、语言、方式、抽检',
    groups: ['delivery_format', 'delivery_language', 'delivery_method', 'sampling_policy'],
  },
  {
    id: 'base',
    label: '基础字段',
    description: '机器人状态、标注类型',
    groups: ['robot_state', 'annotation_type'],
  },
];

const globalFieldCategories = globalFieldCategoryConfigs
  .map((category) => ({
    ...category,
    groups: category.groups.filter((group) => globalFieldGroups.includes(group)),
  }))
  .filter((category) => category.groups.length > 0);

function findGlobalFieldCategory(group: GlobalFieldGroup) {
  return globalFieldCategories.find((category) => category.groups.includes(group));
}

const fallbackRobotRandomOptions: Option[] = [
  { value: 'initial_position', label: '位置' },
  { value: 'initial_yaw', label: '朝向' },
];
const fallbackMaterialRandomOptions: Option[] = [
  { value: 'location', label: '物料位置' },
  { value: 'pose', label: '物料姿态' },
  { value: 'form', label: '物料形态' },
];
const defaultAttachmentStorageStatus: AttachmentStorageStatus = { enabled: true, message: '' };

const api = {
  async data(): Promise<AppData> {
    return fetchJson<AppData>('/api/data');
  },
  async storageStatus(): Promise<{ attachments: AttachmentStorageStatus }> {
    return fetchJson<{ attachments: AttachmentStorageStatus }>('/api/storage-status');
  },
  async saveCustomer(customer: Customer): Promise<Customer[]> {
    return fetchJson<Customer[]>('/api/customers', postJson(customer));
  },
  async saveMaterial(material: Material): Promise<Material[]> {
    return fetchJson<Material[]>('/api/materials', postJson(material));
  },
  async saveRobot(robot: RobotModel): Promise<RobotModel[]> {
    return fetchJson<RobotModel[]>('/api/robot-models', postJson(robot));
  },
  async saveScene(scene: Scene): Promise<Scene[]> {
    return fetchJson<Scene[]>('/api/scenes', postJson(scene));
  },
  async saveGlobalField(field: GlobalField): Promise<GlobalField[]> {
    return fetchJson<GlobalField[]>('/api/global-fields', postJson(field));
  },
  async saveRequirement(id: string, version: VersionPatch<RequirementVersion>): Promise<Requirement[]> {
    return fetchJson<Requirement[]>(`/api/requirements/${id}`, putJson(version));
  },
  async deleteRequirementVersion(id: string, version: string): Promise<Requirement[]> {
    return fetchJson<Requirement[]>(`/api/requirements/${id}/versions/${version}`, { method: 'DELETE' });
  },
  async createRequirement(version: Partial<RequirementVersion>): Promise<Requirement[]> {
    return fetchJson<Requirement[]>('/api/requirements', postJson(version));
  },
  async confirmRequirement(id: string, version: string): Promise<Requirement[]> {
    return fetchJson<Requirement[]>(`/api/requirements/${id}/confirm`, postJson({ version }));
  },
  async saveSubscene(sceneId: string, code: string, version: VersionPatch<SubsceneVersion>): Promise<Scene[]> {
    return fetchJson<Scene[]>(`/api/scenes/${sceneId}/subscenes/${code}/versions`, postJson(version));
  },
  async deleteSubsceneVersion(sceneId: string, code: string, version: string): Promise<Scene[]> {
    return fetchJson<Scene[]>(`/api/scenes/${sceneId}/subscenes/${code}/versions/${version}`, { method: 'DELETE' });
  },
  async confirmSubscene(sceneId: string, code: string, version: string): Promise<Scene[]> {
    return fetchJson<Scene[]>(`/api/scenes/${sceneId}/subscenes/${code}/confirm`, postJson({ version }));
  },
  async exportYaml(id: string, version: string): Promise<ExportResult> {
    return fetchJson<ExportResult>(`/api/requirements/${id}/export-yaml`, postJson({ version }));
  },
  async initAttachmentUpload(id: string, version: string, file: File): Promise<AttachmentUploadInit> {
    return fetchJson<AttachmentUploadInit>(
      `/api/requirements/${id}/versions/${version}/attachments/init`,
      postJson({ fileName: file.name, size: file.size, contentType: file.type || 'application/octet-stream' }),
    );
  },
  async uploadAttachmentPart(
    id: string,
    version: string,
    uploadId: string,
    storageKey: string,
    partNumber: number,
    chunk: Blob,
  ): Promise<AttachmentUploadPart> {
    return fetchBinaryJson<AttachmentUploadPart>(
      `/api/requirements/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/attachments/${encodeURIComponent(
        uploadId,
      )}/parts/${partNumber}?storageKey=${encodeURIComponent(storageKey)}`,
      chunk,
    );
  },
  async completeAttachmentUpload(
    id: string,
    version: string,
    attachmentId: string,
    uploadId: string,
    storageKey: string,
    parts: AttachmentUploadPart[],
  ): Promise<RequirementAttachment & { url: string }> {
    return fetchJson<RequirementAttachment & { url: string }>(
      `/api/requirements/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/attachments/${encodeURIComponent(attachmentId)}/complete`,
      postJson({ uploadId, storageKey, parts }),
    );
  },
  async abortAttachmentUpload(id: string, version: string, attachmentId: string, uploadId: string, storageKey: string): Promise<void> {
    await fetchJson<{ ok: boolean }>(
      `/api/requirements/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/attachments/${encodeURIComponent(attachmentId)}/abort`,
      postJson({ uploadId, storageKey }),
    );
  },
  async deleteAttachment(id: string, version: string, attachmentId: string): Promise<Requirement[]> {
    return fetchJson<Requirement[]>(
      `/api/requirements/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: 'DELETE' },
    );
  },
  async initSubsceneAttachmentUpload(sceneId: string, code: string, version: string, file: File): Promise<AttachmentUploadInit> {
    return fetchJson<AttachmentUploadInit>(
      `/api/scenes/${encodeURIComponent(sceneId)}/subscenes/${encodeURIComponent(code)}/versions/${encodeURIComponent(version)}/attachments/init`,
      postJson({ fileName: file.name, size: file.size, contentType: file.type || 'application/octet-stream' }),
    );
  },
  async uploadSubsceneAttachmentPart(
    sceneId: string,
    code: string,
    version: string,
    uploadId: string,
    storageKey: string,
    partNumber: number,
    chunk: Blob,
  ): Promise<AttachmentUploadPart> {
    return fetchBinaryJson<AttachmentUploadPart>(
      `/api/scenes/${encodeURIComponent(sceneId)}/subscenes/${encodeURIComponent(code)}/versions/${encodeURIComponent(
        version,
      )}/attachments/${encodeURIComponent(uploadId)}/parts/${partNumber}?storageKey=${encodeURIComponent(storageKey)}`,
      chunk,
    );
  },
  async completeSubsceneAttachmentUpload(
    sceneId: string,
    code: string,
    version: string,
    attachmentId: string,
    uploadId: string,
    storageKey: string,
    parts: AttachmentUploadPart[],
  ): Promise<RequirementAttachment & { url: string }> {
    return fetchJson<RequirementAttachment & { url: string }>(
      `/api/scenes/${encodeURIComponent(sceneId)}/subscenes/${encodeURIComponent(code)}/versions/${encodeURIComponent(
        version,
      )}/attachments/${encodeURIComponent(attachmentId)}/complete`,
      postJson({ uploadId, storageKey, parts }),
    );
  },
  async abortSubsceneAttachmentUpload(sceneId: string, code: string, version: string, attachmentId: string, uploadId: string, storageKey: string): Promise<void> {
    await fetchJson<{ ok: boolean }>(
      `/api/scenes/${encodeURIComponent(sceneId)}/subscenes/${encodeURIComponent(code)}/versions/${encodeURIComponent(
        version,
      )}/attachments/${encodeURIComponent(attachmentId)}/abort`,
      postJson({ uploadId, storageKey }),
    );
  },
  async deleteSubsceneAttachment(sceneId: string, code: string, version: string, attachmentId: string): Promise<Scene[]> {
    return fetchJson<Scene[]>(
      `/api/scenes/${encodeURIComponent(sceneId)}/subscenes/${encodeURIComponent(code)}/versions/${encodeURIComponent(
        version,
      )}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: 'DELETE' },
    );
  },
  async initMaterialImageUpload(materialId: string, file: File): Promise<AttachmentUploadInit> {
    return fetchJson<AttachmentUploadInit>(
      `/api/materials/${encodeURIComponent(materialId)}/images/init`,
      postJson({ fileName: file.name, size: file.size, contentType: file.type || 'application/octet-stream' }),
    );
  },
  async uploadMaterialImagePart(
    materialId: string,
    uploadId: string,
    storageKey: string,
    partNumber: number,
    chunk: Blob,
  ): Promise<AttachmentUploadPart> {
    return fetchBinaryJson<AttachmentUploadPart>(
      `/api/materials/${encodeURIComponent(materialId)}/images/${encodeURIComponent(uploadId)}/parts/${partNumber}?storageKey=${encodeURIComponent(storageKey)}`,
      chunk,
    );
  },
  async completeMaterialImageUpload(
    materialId: string,
    attachmentId: string,
    uploadId: string,
    storageKey: string,
    parts: AttachmentUploadPart[],
  ): Promise<RequirementAttachment & { url: string }> {
    return fetchJson<RequirementAttachment & { url: string }>(
      `/api/materials/${encodeURIComponent(materialId)}/images/${encodeURIComponent(attachmentId)}/complete`,
      postJson({ uploadId, storageKey, parts }),
    );
  },
  async abortMaterialImageUpload(materialId: string, attachmentId: string, uploadId: string, storageKey: string): Promise<void> {
    await fetchJson<{ ok: boolean }>(
      `/api/materials/${encodeURIComponent(materialId)}/images/${encodeURIComponent(attachmentId)}/abort`,
      postJson({ uploadId, storageKey }),
    );
  },
  async deleteMaterialImage(materialId: string, attachmentId: string): Promise<Material[]> {
    return fetchJson<Material[]>(`/api/materials/${encodeURIComponent(materialId)}/images/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
  },
};

function postJson(body: unknown) {
  return {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(body),
  };
}

function putJson(body: unknown) {
  return {
    method: 'PUT',
    headers: apiHeaders(),
    body: JSON.stringify(body),
  };
}

function apiHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const password = storedPassword();
  return {
    'Content-Type': 'application/json',
    ...(password ? { Authorization: `Bearer ${password}` } : {}),
    ...headers,
  };
}

function storedPassword(): string {
  return typeof window === 'undefined' ? '' : window.localStorage.getItem(authStorageKey) || '';
}

function clearStoredPassword() {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(authStorageKey);
  }
}

function isAuthError(message: string): boolean {
  return message.includes('访问密码');
}

async function assertJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T | { message?: string };
  if (!res.ok) {
    const message =
      typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string'
        ? data.message
        : '请求失败';
    throw new Error(message);
  }
  return data as T;
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  try {
    const res = await fetch(input, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        ...apiHeaders(),
      },
    });
    return assertJson<T>(res);
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Failed to fetch') {
      throw new Error('本地 API 服务未连接，请用 pnpm dev 同时启动前端和后端后再试');
    }
    throw error;
  }
}

async function fetchBinaryJson<T>(input: RequestInfo | URL, body: Blob): Promise<T> {
  const res = await fetch(input, {
    method: 'PUT',
    headers: apiHeaders({ 'Content-Type': body.type || 'application/octet-stream' }),
    body,
  });
  return assertJson<T>(res);
}

const emptyData: AppData = {
  metadata: defaultAppMetadata,
  customers: [],
  materials: [],
  robotModels: [],
  scenes: [],
  requirements: [],
  globalFields: [],
  materialStateRules: [],
};

function initialPage(): Page {
  if (typeof window === 'undefined') return 'requirements';
  const stored = window.localStorage.getItem(pageStorageKey);
  return isPage(stored) ? stored : 'requirements';
}

function isPage(value: string | null): value is Page {
  return ['requirements', 'scenes', 'globalFields', 'customers', 'materials', 'robots'].includes(value || '');
}

function latest<T extends { version: string }>(versions: T[]): T {
  return versions[versions.length - 1];
}

function statusText(status: string): string {
  if (status === 'active') return '启用';
  if (status === 'inactive') return '停用';
  return status === 'confirmed' ? '已确认' : status === 'archived' ? '已归档' : '草稿';
}

function shouldShowSuccessToast(message: string): boolean {
  return !message.includes('已保存');
}

function formatShortDate(value?: string): string {
  return value ? value.slice(0, 10) : '-';
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'export';
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function matchesQuery(query: string, values: Array<string | number | undefined>): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return values.some((value) => String(value ?? '').toLowerCase().includes(normalized));
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

function exportReportAsPdf(report: PrintableReport) {
  const iframe = document.createElement('iframe');
  iframe.title = report.fileName;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.opacity = '0';

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    iframe.remove();
  }

  iframe.onload = () => {
    const printFrame = iframe.contentWindow;
    if (!printFrame) {
      cleanup();
      window.alert('PDF 导出初始化失败，请刷新页面后重试。');
      return;
    }
    window.setTimeout(() => {
      try {
        printFrame.onafterprint = cleanup;
        printFrame.focus();
        printFrame.print();
      } catch {
        window.alert('无法打开打印对话框，请检查浏览器打印权限后重试。');
        cleanup();
      } finally {
        window.setTimeout(cleanup, 60_000);
      }
    }, 100);
  };

  document.body.appendChild(iframe);
  const iframeDocument = iframe.contentDocument || iframe.contentWindow?.document;
  if (!iframeDocument) {
    cleanup();
    window.alert('PDF 导出初始化失败，请刷新页面后重试。');
    return;
  }
  iframeDocument.open();
  iframeDocument.write(renderPrintableReport(report));
  iframeDocument.close();
}

function renderPrintableReport(report: PrintableReport): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(report.fileName)}</title>
  <style>
    @page { size: A4; margin: 16mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #172033;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 12px;
      line-height: 1.65;
    }
    h1, h2, h3, p { margin: 0; }
    .report-header {
      border-bottom: 2px solid #172033;
      padding-bottom: 14px;
      margin-bottom: 18px;
    }
    .report-header h1 {
      font-size: 24px;
      line-height: 1.25;
    }
    .report-header p {
      margin-top: 6px;
      color: #5f6b7a;
      font-size: 12px;
    }
    section {
      break-inside: avoid;
      margin: 0 0 16px;
    }
    h2 {
      border-left: 4px solid #2563eb;
      padding-left: 8px;
      margin-bottom: 8px;
      font-size: 15px;
    }
    .section-desc {
      color: #667085;
      margin-bottom: 8px;
    }
    pre {
      margin: 0;
      padding: 10px 12px;
      border: 1px solid #d8dee8;
      border-radius: 6px;
      background: #f8fafc;
      color: #172033;
      white-space: pre-wrap;
      word-break: break-word;
      font: inherit;
    }
    .attachments {
      display: grid;
      gap: 10px;
      margin-top: 10px;
    }
    .attachment-card {
      break-inside: avoid;
      border: 1px solid #d8dee8;
      border-radius: 6px;
      background: #f8fafc;
      padding: 10px;
    }
    .attachment-card img {
      display: block;
      max-width: 100%;
      max-height: 96mm;
      object-fit: contain;
      margin-bottom: 8px;
    }
    .attachment-card a {
      color: #1d4ed8;
      text-decoration: none;
      word-break: break-all;
    }
    .attachment-meta {
      color: #667085;
      font-size: 11px;
    }
    .footer {
      margin-top: 24px;
      padding-top: 10px;
      border-top: 1px solid #d8dee8;
      color: #667085;
      font-size: 11px;
    }
    @media print {
      body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <header class="report-header">
    <h1>${escapeHtml(report.title)}</h1>
    ${report.subtitle ? `<p>${escapeHtml(report.subtitle)}</p>` : ''}
  </header>
  ${report.sections
    .filter((section) => section.content.trim() || section.attachments?.length)
    .map(
      (section) => `<section>
    <h2>${escapeHtml(section.title)}</h2>
    ${section.description ? `<p class="section-desc">${escapeHtml(section.description)}</p>` : ''}
    ${section.content.trim() ? `<pre>${escapeHtml(section.content)}</pre>` : ''}
    ${renderPrintableAttachments(section.attachments)}
  </section>`,
    )
    .join('')}
  <div class="footer">由 coScene SOP 需求管理系统生成 · ${escapeHtml(new Date().toLocaleString('zh-CN'))}</div>
</body>
</html>`;
}

function renderPrintableAttachments(attachments: PrintableSection['attachments']): string {
  if (!attachments?.length) return '';
  return `<div class="attachments">${attachments
    .map((attachment) => {
      const meta = `${attachment.contentType || '未知类型'} · ${formatFileSize(attachment.size)} · ${formatShortDate(attachment.uploadedAt)}`;
      const name = escapeHtml(attachment.name);
      const url = attachment.url ? escapeHtml(attachment.url) : '';
      const media =
        attachment.contentType.startsWith('image/') && attachment.url
          ? `<img src="${url}" alt="${name}" />`
          : '';
      const link = attachment.url ? `<a href="${url}">${name}</a>` : `<strong>${name}</strong>`;
      return `<div class="attachment-card">${media}<div>${link}</div><div class="attachment-meta">${escapeHtml(meta)}</div></div>`;
    })
    .join('')}</div>`;
}

function escapeHtml(value: string | number | undefined | null): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function reportValue(value: string | number | boolean | undefined | null): string {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

function reportList(values: Array<string | number | undefined | null> | undefined): string {
  const items = (values || []).map((value) => String(value ?? '').trim()).filter(Boolean);
  return items.length ? items.join('、') : '-';
}

function formatImageNames(ids: string[] | undefined, attachments: RequirementAttachment[] | undefined): string {
  const names = (ids || [])
    .map((id) => attachments?.find((attachment) => attachment.id === id)?.name || id)
    .filter(Boolean);
  return names.length ? names.join('、') : '-';
}

function stateSentence(row: InitialLocationRow): string {
  const parts = [`把 ${row.object || '物料'}`];
  const primary = [row.primaryReferences[0], row.primaryRelativePositions[0]].filter(Boolean).join('的');
  if (primary) parts.push(`放在 ${primary}`);
  if (row.supportSurfaces[0]) parts.push(`接触 ${row.supportSurfaces[0]}`);
  if (row.regions.length) parts.push(`区域为 ${row.regions.join('、')}`);
  if (row.secondaryReferences[0] || row.secondaryRelativePositions[0]) {
    parts.push(`更具体位置为 ${[row.secondaryReferences[0], row.secondaryRelativePositions[0]].filter(Boolean).join('的')}`);
  }
  if (row.poses.length) parts.push(`姿态为 ${row.poses.join('、')}`);
  if (row.forms.length) parts.push(`形态为 ${row.forms.join('、')}`);
  if (row.parameters.length) parts.push(`参数为 ${row.parameters.join('、')}`);
  return parts.join('，') + '。';
}

function stateReportLine(row: InitialLocationRow, attachments?: RequirementAttachment[]): string {
  return [
    stateSentence(row),
    row.collectorInstruction ? `采集员说明：${row.collectorInstruction}` : '',
    row.exampleImageAttachmentIds.length ? `示例图：${formatImageNames(row.exampleImageAttachmentIds, attachments)}` : '',
    row.constraints.length ? `限制条件：${row.constraints.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('；');
}

function materialRandomizationSentence(row: MaterialInitialRandomizationRow): string {
  const materials = row.targetMaterials.length ? row.targetMaterials.join('、') : '所选物料';
  const fields = row.randomizedFields.length ? row.randomizedFields.join('、') : '位置/姿态/形态';
  return `${materials} 每 ${row.changeIntervalRecords || 1} 条换一次，需要变化 ${fields}。`;
}

function materialRandomizationReportLine(row: MaterialInitialRandomizationRow, attachments?: RequirementAttachment[]): string {
  return [
    materialRandomizationSentence(row),
    row.collectorInstruction ? `采集员说明：${row.collectorInstruction}` : '',
    row.exampleImageAttachmentIds.length ? `示例图：${formatImageNames(row.exampleImageAttachmentIds, attachments)}` : '',
    row.constraints ? `限制条件：${row.constraints}` : '',
  ]
    .filter(Boolean)
    .join('；');
}

function keyValueReport(rows: Array<[string, string | number | boolean | undefined | null]>): string {
  return rows.map(([label, value]) => `${label}：${reportValue(value)}`).join('\n');
}

function numberedReportSteps(steps: OperationStep[] | undefined): string {
  if (!steps?.length) return '-';
  return steps.map((step, index) => `${step.order || index + 1}. ${step.description || '-'}`).join('\n');
}

function bilingualReportSteps(steps: OperationStep[] | undefined): string {
  if (!steps?.length) return '-';
  return steps
    .map((step, index) => {
      const order = step.order || index + 1;
      const zhSkill = step.atomicSkill ? `；原子技能：${step.atomicSkill}` : '';
      const enStep = step.englishDescription ? `；EN：${step.englishDescription}` : '';
      const enSkill = step.englishAtomicSkill ? `；EN Skill：${step.englishAtomicSkill}` : '';
      return `${order}. ${step.description || '-'}${zhSkill}${enStep}${enSkill}`;
    })
    .join('\n');
}

function textItemsReport(items: TextItem[] | undefined): string {
  if (!items?.length) return '-';
  return items.map((item, index) => `${index + 1}. ${item.description || item.type || '-'}`).join('\n');
}

function operationItemsReport(items: Array<{ operation: string; note: string }> | undefined): string {
  if (!items?.length) return '-';
  return items.map((item, index) => `${index + 1}. ${item.operation}${item.note ? `：${item.note}` : ''}`).join('\n');
}

function forbiddenRequirementReport(groups: RequirementVersion['forbiddenOperations']): string {
  const lines = groups.flatMap((group) =>
    group.operations.map((item) => `${group.category ? `${group.category} / ` : ''}${item.operation}${item.note ? `：${item.note}` : ''}`),
  );
  return lines.length ? lines.map((line, index) => `${index + 1}. ${line}`).join('\n') : '-';
}

function formatQuantity(material: SubsceneVersion['materials'][number]): string {
  const unit = material.quantity.unit || '件';
  if (material.quantity.mode === 'range') {
    return `${reportValue(material.quantity.min)}-${reportValue(material.quantity.max)} ${unit}`;
  }
  return `${reportValue(material.quantity.value)} ${unit}`;
}

function materialsReport(materials: SubsceneVersion['materials']): string {
  if (!materials.length) return '-';
  return materials
    .map(
      (material, index) =>
        `${index + 1}. ${material.skuId} / ${material.type} / 数量 ${formatQuantity(material)} / 颜色 ${reportValue(
          material.color,
        )} / 材质 ${reportValue(material.material)} / 包装 ${reportValue(material.packageType)}`,
    )
    .join('\n');
}

function initialStatesReport(states: SubsceneVersion['objectStates']['initial'], attachments?: RequirementAttachment[]): string {
  const rows = initialStateRows(states);
  if (!rows.length) return '-';
  return rows.map((row, index) => `${index + 1}. ${stateReportLine(row, attachments)}`).join('\n');
}

function targetStatesReport(states: SubsceneVersion['objectStates']['target'], attachments?: RequirementAttachment[]): string {
  const rows = targetStateRows(states);
  if (!rows.length) return '-';
  return rows.map((row, index) => `${index + 1}. ${stateReportLine(row, attachments)}`).join('\n');
}

function robotRandomizationReport(version: SubsceneVersion): string {
  const rows = robotInitialRandomizationRows(version.randomization, version.randomizationFrequency);
  if (!rows.length) return '-';
  return rows
    .map(
      (row, index) =>
        `${index + 1}. ${row.target}：每 ${row.changeIntervalRecords || 1} 条变换一次；随机字段 ${reportList(
          row.randomizedFields,
        )}；限制 ${reportValue(row.constraints)}`,
    )
    .join('\n');
}

function materialRandomizationReport(version: SubsceneVersion): string {
  const rows = materialInitialRandomizationRows(version.randomization);
  if (!rows.length) return '-';
  return rows.map((row, index) => `${index + 1}. ${materialRandomizationReportLine(row, version.attachments)}`).join('\n');
}

function stepRandomizationReport(value?: { enabled: boolean; startOrder: number; endOrder: number }): string {
  if (!value?.enabled) return '未启用';
  return `第 ${value.startOrder || 1} 步到第 ${value.endOrder || 1} 步顺序可随机`;
}

function publicAttachmentUrl(publicBaseUrl: string | undefined, storageKey: string): string {
  if (!publicBaseUrl) return '';
  const base = publicBaseUrl.replace(/\/+$/, '');
  const encodedKey = storageKey.split('/').map(encodeURIComponent).join('/');
  return `${base}/${encodedKey}`;
}

function printableAttachments(attachments: RequirementAttachment[] | undefined, publicBaseUrl?: string): PrintableAttachment[] {
  return (attachments || []).map((attachment) => ({
    name: attachment.name,
    size: attachment.size,
    contentType: attachment.contentType,
    uploadedAt: attachment.uploadedAt,
    url: publicAttachmentUrl(publicBaseUrl, attachment.storageKey) || undefined,
  }));
}

function protectedAttachmentUrl(storageKey: string): string {
  return `/api/attachments/${encodeURIComponent(storageKey)}`;
}

async function downloadStoredAttachment(attachment: RequirementAttachment) {
  const res = await fetch(protectedAttachmentUrl(attachment.storageKey), { headers: apiHeaders() });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({ message: '下载失败' }))) as { message?: string };
    throw new Error(error.message || '下载失败');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = attachment.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function subsceneReportSections(scene: Scene, subscene: Subscene, version: SubsceneVersion, publicBaseUrl?: string): PrintableSection[] {
  return [
    {
      title: '基础信息',
      content: keyValueReport([
        ['场景', scene.name],
        ['任务 SOP 名称', version.title || subscene.name],
        ['版本', version.version],
        ['状态', statusText(version.status)],
        ['更新时间', formatShortDate(version.updatedAt)],
        ['描述', version.description],
      ]),
    },
    {
      title: '机器人与随机性',
      content: [
        keyValueReport([
          ['机器人初始态', version.robotState.initial],
          ['机器人目标态', version.robotState.target],
        ]),
        '',
        '机器人初始态随机性：',
        robotRandomizationReport(version),
      ].join('\n'),
    },
    {
      title: '物料',
      content: materialsReport(version.materials),
    },
    {
      title: '物料状态',
      content: [
        '物料初始状态：',
        initialStatesReport(version.objectStates.initial, version.attachments),
        '',
        '物料目标状态：',
        targetStatesReport(version.objectStates.target, version.attachments),
      ].join('\n'),
    },
    {
      title: '物料随机性',
      content: materialRandomizationReport(version),
    },
    {
      title: '采集步骤和说明',
      content: [
        '采集步骤：',
        numberedReportSteps(version.operation.steps),
        '',
        `采集步骤随机性：${stepRandomizationReport(version.operation.stepRandomization)}`,
        '',
        '采集操作要求：',
        textItemsReport(version.operation.allowedOperations),
        '',
        '采集禁止操作：',
        textItemsReport(version.operation.forbiddenOperations),
      ].join('\n'),
    },
    {
      title: '标注步骤和说明',
      content: [
        keyValueReport([['标注状态', version.annotation.status]]),
        '',
        '标注步骤：',
        bilingualReportSteps(version.annotation.steps),
        '',
        '标注操作要求：',
        textItemsReport(version.annotation.allowedOperations),
        '',
        '标注禁止操作：',
        textItemsReport(version.annotation.forbiddenOperations),
      ].join('\n'),
    },
    {
      title: '任务 SOP 附件',
      content: version.attachments?.length ? '附件内容如下。' : '-',
      attachments: printableAttachments(version.attachments, publicBaseUrl),
    },
  ];
}

function buildSubscenePdfReport(scene: Scene, subscene: Subscene, version: SubsceneVersion, publicBaseUrl?: string): PrintableReport {
  return {
    title: version.title || subscene.name,
    subtitle: `${scene.name} · 任务 SOP 版本 v${version.version} · ${statusText(version.status)}`,
    fileName: `${safeFileName(version.title || subscene.name)}-${version.version}.pdf`,
    sections: subsceneReportSections(scene, subscene, version, publicBaseUrl),
  };
}

function selectedSubscenesReport(
  scenes: Scene[],
  selectedSubscenes: RequirementVersion['selectedSubscenes'],
  publicBaseUrl?: string,
): PrintableSection[] {
  if (!selectedSubscenes.length) {
    return [{ title: '生产需求项', content: '-' }];
  }
  return selectedSubscenes.map((selected, index) => {
    const target = findTaskSop(scenes, selected);
    const selectedTaskSopName = taskSopLabel(selected);
    const selectedVersion = taskSopVersion(selected);
    const header = keyValueReport([
      ['生产需求项名称', productionItemTitle(selected)],
      ['生产需求项描述', selected.description],
      ['需求项场景', productionItemSceneName(selected)],
      ['选择的任务 SOP', selectedTaskSopName || '未选择'],
      ['SOP 引用版本', selectedVersion || '-'],
      ['引用版本状态', target?.version ? statusText(target.version.status) : '未找到'],
      ['目标采集时长', `${selected.targetDurationHours || 0} h`],
      ['目标采集数量', `${selected.targetCollectionCount || 0}`],
    ]);
    const detail =
      selectedTaskSopName && target?.version && target.subscene
        ? subsceneReportSections(target.scene, target.subscene, target.version, publicBaseUrl)
            .map((section) => `【${section.title}】\n${section.content}`)
            .join('\n\n')
        : '未选择或未找到对应任务 SOP 版本，无法展开正文。';
    return {
      title: `生产需求项 ${index + 1}：${productionItemTitle(selected)}`,
      content: `${header}\n\n${detail}`,
      attachments: printableAttachments(target?.version?.attachments, publicBaseUrl),
    };
  });
}

function buildRequirementPdfReport(data: AppData, requirement: Requirement, version: RequirementVersion, publicBaseUrl?: string): PrintableReport {
  const customer = data.customers.find((item) => item.id === version.customerId);
  const robot = data.robotModels.find((item) => item.id === version.robotModelId);
  const selectedDurationTotal = version.selectedSubscenes.reduce((total, item) => total + (Number(item.targetDurationHours) || 0), 0);
  return {
    title: version.title,
    subtitle: `需求版本 v${version.version} · ${statusText(version.status)}`,
    fileName: `${safeFileName(version.title)}-${version.version}.pdf`,
    sections: [
      {
        title: '基础信息',
        content: keyValueReport([
          ['需求名称', version.title],
          ['客户', customer?.name],
          ['联系人', customer?.contact.name],
          ['项目名称', version.projectName],
          ['截止日期', formatShortDate(version.deadline)],
          ['需求状态', statusText(version.status)],
          ['需求版本', version.version],
          ['机器人型号', robot ? `${robot.brand} ${robot.model}` : '-'],
          ['业务目标', version.businessGoal],
          ['总目标时长', `${version.requiredDurationHours || 0} h`],
          ['生产需求项目标时长合计', `${selectedDurationTotal} h`],
        ]),
      },
      {
        title: '交付 / 标注 / 质检',
        content: keyValueReport([
          ['交付方式', version.delivery.method],
          ['交付格式', reportList(version.delivery.formats)],
          ['交付语言', reportList(version.delivery.languages.map((item) => `${item.code} ${item.name}`))],
          ['数据交付结构', version.delivery.dataStructureUrl],
          ['是否需要标注', version.annotation.required],
          ['标注类型', reportList(version.annotation.types)],
          ['是否需要质检', version.qualityInspection.required],
          ['客户抽检策略', version.qualityInspection.samplingPolicy],
        ]),
      },
      {
        title: '说明补充',
        content: keyValueReport([
          ['客户额外 topic 要求', version.extraTopicRequirementsText],
          ['全局随机性要求', version.globalRandomizationRequirements],
          ['其他补充说明', version.additionalNotes],
        ]),
      },
      {
        title: '客户需求附件',
        content: version.attachments?.length ? '附件内容如下。' : '-',
        attachments: printableAttachments(version.attachments, publicBaseUrl),
      },
      {
        title: '客户需求层操作要求',
        content: [
          '采集操作要求：',
          operationItemsReport(version.allowedOperations),
          '',
          '不完美但可接受的采集操作：',
          operationItemsReport(version.acceptableOperations),
          '',
          '采集禁止操作：',
          forbiddenRequirementReport(version.forbiddenOperations),
          '',
          '标注操作要求：',
          operationItemsReport(version.annotation.allowedOperations),
          '',
          '标注禁止操作：',
          operationItemsReport(version.annotation.forbiddenOperations),
        ].join('\n'),
      },
      ...selectedSubscenesReport(data.scenes, version.selectedSubscenes, publicBaseUrl),
    ],
  };
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

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(0, 8);
}

function versionId(objectId: string | undefined, version: string | undefined): string {
  if (!objectId || !version) return '';
  return `${objectId}@${version}`;
}

function versionRank(value: string): number[] {
  return value.split('.').map((part) => Number.parseInt(part, 10) || 0);
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

function taskSopObjectIdFromParts(sceneId: string, taskSopName: string): string {
  return `sop_${stableHash(`${sceneId}:${taskSopName}`)}`;
}

function sceneLatestUpdated(scene: Scene): string {
  const updatedAt = scene.subscenes
    .flatMap((subscene) => subscene.versions.map((version) => version.updatedAt))
    .filter(Boolean)
    .sort()
    .at(-1);
  return formatShortDate(updatedAt);
}

function nextSubsceneCode(scenes: Scene[]): string {
  return randomShortCode(scenes.flatMap((scene) => scene.subscenes.map((subscene) => subscene.code)));
}

function randomShortCode(usedCodes: string[] = [], length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const used = new Set(usedCodes.map((code) => code.toUpperCase()));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let index = 0; index < length; index += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!used.has(code)) return code;
  }
  return Date.now().toString(36).slice(-length).toUpperCase();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function findSubscene(scenes: Scene[], code: string, version?: string): SubsceneLookupResult | undefined {
  for (const scene of scenes) {
    const subscene = scene.subscenes.find((item) => item.code === code);
    if (!subscene) continue;
    const foundVersion = version ? subscene.versions.find((item) => item.version === version) : undefined;
    return {
      scene,
      subscene,
      version: foundVersion,
    };
  }
  return undefined;
}

function findTaskSop(scenes: Scene[], selected: RequirementVersion['selectedSubscenes'][number]): SubsceneLookupResult | undefined {
  const ref = selected.taskSop;
  if (selected.subsceneCode) {
    const byCode = findSubscene(scenes, selected.subsceneCode, selected.version);
    if (byCode) return byCode;
  }
  for (const scene of scenes) {
    const sceneName = ref?.sceneName || selected.sceneName;
    if (scene.name !== sceneName) continue;
    const subscene = scene.subscenes.find((item) => {
      const selectedVersion = ref?.version || selected.version;
      const selectedTitle = ref?.title || selected.subsceneName;
      const version = item.versions.find((candidate) => candidate.version === selectedVersion);
      return item.name === selectedTitle || version?.title === selectedTitle;
    });
    if (!subscene) continue;
    return {
      scene,
      subscene,
      version: subscene.versions.find((item) => item.version === (ref?.version || selected.version)),
    };
  }
  return undefined;
}

function productionItemTitle(item: RequirementVersion['selectedSubscenes'][number]): string {
  return item.title || item.subsceneName || item.taskSop?.title || '未命名生产需求项';
}

function productionItemSceneName(item: RequirementVersion['selectedSubscenes'][number]): string {
  return item.sceneName || item.taskSop?.sceneName || '';
}

function productionItemKey(item: RequirementVersion['selectedSubscenes'][number]): string {
  return item.id || [productionItemSceneName(item), productionItemTitle(item), item.taskSop?.version || item.version || ''].join('::');
}

function taskSopLabel(item: RequirementVersion['selectedSubscenes'][number]): string {
  return item.taskSop?.title || item.subsceneName || '';
}

function taskSopVersion(item: RequirementVersion['selectedSubscenes'][number]): string {
  return item.taskSop?.version || item.version || '';
}

function taskSopStatus(item: RequirementVersion['selectedSubscenes'][number]): EntityStatus | undefined {
  return item.taskSop?.status;
}

function candidateTaskSopReference(candidate: CandidateSubsceneOption) {
  const sopId = taskSopObjectIdFromParts(candidate.sceneId, candidate.name);
  return {
    sceneName: candidate.sceneName,
    title: candidate.selectedVersion.title || candidate.name,
    version: candidate.selectedVersion.version,
    versionId: versionId(sopId, candidate.selectedVersion.version),
    parentVersionId: parentVersionId(sopId, candidate.versions, candidate.selectedVersion.version),
    status: candidate.selectedVersion.status,
  };
}

function candidateTaskSopKey(candidate: CandidateSubsceneOption): string {
  return [candidate.sceneId, candidate.code, candidate.selectedVersion.version].join('::');
}

function isSameTaskSopCandidate(item: RequirementVersion['selectedSubscenes'][number], candidate: CandidateSubsceneOption): boolean {
  const ref = candidateTaskSopReference(candidate);
  return taskSopLabel(item) === ref.title && taskSopVersion(item) === ref.version && (item.taskSop?.sceneName || item.sceneName) === ref.sceneName;
}

function isSameProductionItem(
  left: RequirementVersion['selectedSubscenes'][number],
  right: RequirementVersion['selectedSubscenes'][number],
): boolean {
  return productionItemKey(left) === productionItemKey(right);
}

function stripSelectedTaskSopCode(selected: RequirementVersion['selectedSubscenes'][number]): RequirementVersion['selectedSubscenes'][number] {
  const { subsceneCode: _subsceneCode, ...rest } = selected;
  return rest;
}

export default function App() {
  const [data, setData] = useState<AppData>(emptyData);
  const [page, setPageState] = useState<Page>(initialPage);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedRequirementId, setSelectedRequirementId] = useState<string>('');
  const [selectedRequirementVersion, setSelectedRequirementVersion] = useState('');
  const [requirementDetailOpen, setRequirementDetailOpen] = useState(false);
  const [selectedSceneId, setSelectedSceneId] = useState('');
  const [selectedSubsceneCode, setSelectedSubsceneCode] = useState('');
  const [selectedSubsceneVersion, setSelectedSubsceneVersion] = useState('');
  const [sceneDetailOpen, setSceneDetailOpen] = useState(false);
  const [returnToRequirement, setReturnToRequirement] = useState<RequirementReturnTarget | null>(null);
  const [attachmentStorageStatus, setAttachmentStorageStatus] = useState<AttachmentStorageStatus>(defaultAttachmentStorageStatus);

  function setPage(pageName: Page, options: { keepDetail?: boolean } = {}) {
    setPageState(pageName);
    window.localStorage.setItem(pageStorageKey, pageName);
    if (!options.keepDetail) {
      setRequirementDetailOpen(false);
      setSceneDetailOpen(false);
      setReturnToRequirement(null);
    }
  }

  function openRequirementFromSubscene() {
    if (!returnToRequirement) return;
    setSelectedRequirementId(returnToRequirement.requirementId);
    setSelectedRequirementVersion(returnToRequirement.version);
    setRequirementDetailOpen(true);
    setSceneDetailOpen(false);
    setReturnToRequirement(null);
    setPage('requirements', { keepDetail: true });
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const next = await api.data();
      const storage = await api.storageStatus().catch(() => ({ attachments: defaultAttachmentStorageStatus }));
      setData(next);
      setAttachmentStorageStatus(storage.attachments);
      setLocked(false);
      setSelectedRequirementId((current) => current || next.requirements[0]?.id || '');
      setSelectedSceneId((current) => current || next.scenes[0]?.id || '');
      setSelectedSubsceneCode((current) => current || next.scenes[0]?.subscenes[0]?.code || '');
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载失败';
      if (isAuthError(message)) {
        const hadPassword = Boolean(storedPassword());
        clearStoredPassword();
        setLocked(true);
        setError(hadPassword ? message : '');
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!message && !error) return;
    const timer = window.setTimeout(() => {
      setMessage('');
      setError('');
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [message, error]);

  const selectedRequirement = data.requirements.find((item) => item.id === selectedRequirementId);
  const requirementVersion =
    selectedRequirement?.versions.find((item) => item.version === selectedRequirementVersion) ||
    (selectedRequirement ? latest(selectedRequirement.versions) : undefined);

  useEffect(() => {
    if (selectedRequirement && !selectedRequirementVersion) {
      setSelectedRequirementVersion(latest(selectedRequirement.versions).version);
    }
  }, [selectedRequirement, selectedRequirementVersion]);

  async function run<T>(action: () => Promise<T>, success: string): Promise<T | undefined> {
    setError('');
    setMessage('');
    try {
      const result = await action();
      if (shouldShowSuccessToast(success)) {
        setMessage(success);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败';
      if (isAuthError(message)) {
        clearStoredPassword();
        setLocked(true);
        setError(message);
      } else {
        setError(message);
      }
      return undefined;
    }
  }

  if (loading) {
    return <div className="loading">正在加载 SOP 需求管理...</div>;
  }

  if (locked) {
    return <PasswordGate error={error} onUnlock={() => void load()} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">SOP</div>
          <div>
            <strong>需求管理</strong>
            <span>coScene 数据采集</span>
          </div>
        </div>
        <NavButton active={page === 'requirements'} label="客户需求" count={data.requirements.length} onClick={() => setPage('requirements')} />
        <NavButton active={page === 'scenes'} label="场景库" count={data.scenes.length} onClick={() => setPage('scenes')} />
        <NavButton active={page === 'customers'} label="客户" count={data.customers.length} onClick={() => setPage('customers')} />
        <NavButton active={page === 'materials'} label="物料" count={data.materials.length} onClick={() => setPage('materials')} />
        <NavButton active={page === 'robots'} label="机器型号" count={data.robotModels.length} onClick={() => setPage('robots')} />
        <NavButton
          active={page === 'globalFields'}
          label="全局字段"
          count={data.globalFields.length}
          onClick={() => setPage('globalFields')}
        />
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{pageTitle(page)}</h1>
            <p>{pageHint(page)}</p>
          </div>
          <button className="ghost-button" onClick={() => void load()}>
            刷新
          </button>
        </header>
        {(message || error) && (
          <div className="toast-stack" aria-live="polite">
            {message && <div className="notice success">{message}</div>}
            {error && <div className="notice error">{error}</div>}
          </div>
        )}

        {page === 'requirements' && (
          <RequirementPage
            data={data}
            globalFields={data.globalFields}
            selectedRequirement={selectedRequirement}
            selectedVersion={requirementVersion}
            detailOpen={requirementDetailOpen}
            onDetailOpenChange={setRequirementDetailOpen}
            onSelectRequirement={(id) => {
              const target = data.requirements.find((item) => item.id === id);
              setSelectedRequirementId(id);
              setSelectedRequirementVersion(target ? latest(target.versions).version : '');
            }}
            onSelectVersion={setSelectedRequirementVersion}
            onCreate={async () => {
              const result = await run(
                () =>
                  api.createRequirement({
                    title: '新的客户需求',
                    projectName: '',
                    priority: 'P2',
                    deadline: today(),
                    customerId: data.customers[0]?.id || '',
                    robotModelId: data.robotModels[0]?.id || '',
                    requestedScenes: [],
                    selectedSubscenes: [],
                  }),
                '已新建客户需求',
              );
              if (result) {
                setData((current) => ({ ...current, requirements: result }));
                const created = result[result.length - 1];
                setSelectedRequirementId(created.id);
                setSelectedRequirementVersion(latest(created.versions).version);
              }
            }}
            onSave={async (patch) => {
              if (!selectedRequirement || !requirementVersion) return;
              const result = await run(
                () => api.saveRequirement(selectedRequirement.id, { ...patch, baseVersion: requirementVersion.version }),
                requirementVersion.status === 'confirmed' ? '已创建草稿版本' : '已保存客户需求',
              );
              if (result) {
                setData((current) => ({ ...current, requirements: result }));
                const updated = result.find((item) => item.id === selectedRequirement.id);
                if (updated) setSelectedRequirementVersion(latest(updated.versions).version);
              }
            }}
            onDeleteVersion={async () => {
              if (!selectedRequirement || !requirementVersion) return;
              const result = await run(
                () => api.deleteRequirementVersion(selectedRequirement.id, requirementVersion.version),
                '草稿版本已删除',
              );
              if (result) {
                setData((current) => ({ ...current, requirements: result }));
                const updated = result.find((item) => item.id === selectedRequirement.id);
                setSelectedRequirementVersion(updated ? latest(updated.versions).version : '');
              }
            }}
            onConfirm={async () => {
              if (!selectedRequirement || !requirementVersion) return;
              const result = await run(
                () => api.confirmRequirement(selectedRequirement.id, requirementVersion.version),
                '客户需求版本已确认',
              );
              if (result) setData((current) => ({ ...current, requirements: result }));
            }}
            onExport={async () => {
              if (!selectedRequirement || !requirementVersion) return undefined;
              return run(() => api.exportYaml(selectedRequirement.id, requirementVersion.version), 'YAML 已导出');
            }}
            onRun={run}
            attachmentStorageStatus={attachmentStorageStatus}
            onRequirementsChange={(requirements) => setData((current) => ({ ...current, requirements }))}
            onOpenSubscene={(code, version) => {
              const target = findSubscene(data.scenes, code, version);
              if (!target || !selectedRequirement || !requirementVersion) return;
              setReturnToRequirement({ requirementId: selectedRequirement.id, version: requirementVersion.version });
              setSelectedSceneId(target.scene.id);
              setSelectedSubsceneCode(target.subscene.code);
              setSelectedSubsceneVersion(version);
              setSceneDetailOpen(true);
              setPage('scenes', { keepDetail: true });
            }}
          />
        )}

        {page === 'scenes' && (
          <ScenePage
            globalFields={data.globalFields}
            materials={data.materials}
            scenes={data.scenes}
            selectedSceneId={selectedSceneId}
            selectedSubsceneCode={selectedSubsceneCode}
            selectedVersion={selectedSubsceneVersion}
            detailOpen={sceneDetailOpen}
            onSelectScene={(id) => {
              const target = data.scenes.find((item) => item.id === id);
              setSelectedSceneId(id);
              setSelectedSubsceneCode(target?.subscenes[0]?.code || '');
              setSelectedSubsceneVersion('');
            }}
            onSelectSubscene={setSelectedSubsceneCode}
            onSelectVersion={setSelectedSubsceneVersion}
            onDetailOpenChange={setSceneDetailOpen}
            onSaveScene={async (scene) => {
              const result = await run(() => api.saveScene(scene), '场景已保存');
              if (result) {
                setData((current) => ({ ...current, scenes: result }));
                const savedScene = result.find((item) => item.id === scene.id) || result[result.length - 1];
                setSelectedSceneId(savedScene?.id || '');
                const preservedSubscene = savedScene?.subscenes.some((item) => item.code === selectedSubsceneCode)
                  ? selectedSubsceneCode
                  : savedScene?.subscenes[0]?.code || '';
                setSelectedSubsceneCode(preservedSubscene);
              }
            }}
            onSaveSubscene={async (sceneId, code, patch) => {
              const target = data.scenes
                .find((item) => item.id === sceneId)
                ?.subscenes.find((item) => item.code === code)
                ?.versions.find((item) => item.version === patch.baseVersion);
              const result = await run(
                () => api.saveSubscene(sceneId, code, patch),
                target?.status === 'confirmed' ? '已创建草稿版本' : '已保存任务 SOP 版本',
              );
              if (result) setData((current) => ({ ...current, scenes: result }));
            }}
            onDeleteSubsceneVersion={async (sceneId, code, version) => {
              const result = await run(() => api.deleteSubsceneVersion(sceneId, code, version), '草稿版本已删除');
              if (result) setData((current) => ({ ...current, scenes: result }));
            }}
            onConfirmSubscene={async (sceneId, code, version) => {
              const result = await run(() => api.confirmSubscene(sceneId, code, version), '任务 SOP 版本已确认');
              if (result) setData((current) => ({ ...current, scenes: result }));
            }}
            onRun={run}
            attachmentStorageStatus={attachmentStorageStatus}
            onScenesChange={(scenes) => setData((current) => ({ ...current, scenes }))}
            returnToRequirement={returnToRequirement}
            onReturnToRequirement={openRequirementFromSubscene}
            onClearReturnToRequirement={() => setReturnToRequirement(null)}
          />
        )}

        {page === 'globalFields' && (
          <GlobalFieldPage
            globalFields={data.globalFields}
            onSaveField={async (field) => {
              const result = await run(() => api.saveGlobalField(field), '全局字段已保存');
              if (result) setData((current) => ({ ...current, globalFields: result }));
            }}
          />
        )}

        {page === 'customers' && (
          <CustomerPage
            customers={data.customers}
            onSave={async (customer) => {
              const result = await run(() => api.saveCustomer(customer), '客户信息已保存');
              if (result) setData((current) => ({ ...current, customers: result }));
            }}
          />
        )}
        {page === 'materials' && (
          <MaterialPage
            materials={data.materials}
            storageStatus={attachmentStorageStatus}
            onMaterialsChange={(materials) => setData((current) => ({ ...current, materials }))}
            onSave={async (material) => {
              const existing = data.materials.find((item) => item.id === material.id);
              const result = await run(() => api.saveMaterial({ ...material, images: material.images || existing?.images || [] }), '保存成功');
              if (result) {
                setData((current) => ({ ...current, materials: result }));
                return true;
              }
              return false;
            }}
          />
        )}
        {page === 'robots' && (
          <RobotPage
            robots={data.robotModels}
            onSave={async (robot) => {
              const result = await run(() => api.saveRobot(robot), '机器型号已保存');
              if (result) setData((current) => ({ ...current, robotModels: result }));
            }}
          />
        )}
      </main>
    </div>
  );
}

function PasswordGate({ error, onUnlock }: { error: string; onUnlock: () => void }) {
  const [password, setPassword] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedPassword = password.trim();
    if (!normalizedPassword) return;
    window.localStorage.setItem(authStorageKey, normalizedPassword);
    onUnlock();
  }

  return (
    <div className="auth-screen">
      <form className="auth-panel" onSubmit={submit}>
        <div className="brand-mark">SOP</div>
        <div>
          <h1>SOP 需求管理</h1>
          <p>请输入访问密码后继续。</p>
        </div>
        {error && <div className="notice error">{error}</div>}
        <label className="field">
          <span>访问密码</span>
          <input type="password" value={password} autoFocus onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button className="primary-button" disabled={!password.trim()}>
          进入系统
        </button>
      </form>
    </div>
  );
}

function NavButton({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>
      <span>{label}</span>
      <strong>{count}</strong>
    </button>
  );
}

function pageTitle(page: Page) {
  const map: Record<Page, string> = {
    requirements: '客户需求管理',
    scenes: '场景与任务 SOP 库',
    globalFields: '全局字段管理',
    customers: '客户信息',
    materials: '物料信息',
    robots: '机器型号',
  };
  return map[page];
}

function pageHint(page: Page) {
  const map: Record<Page, string> = {
    requirements: '管理客户需求、生产需求项和对应任务 SOP 版本，确认后可导出需求 YAML。',
    scenes: '按场景维护任务 SOP 版本，确认后历史版本保持只读。',
    globalFields: '管理 SOP 表单复用字段，任务 SOP 会从这里选择标准词表。',
    customers: '管理客户和联系人，供客户需求引用。',
    materials: '管理可复用物料主数据，供任务 SOP 版本引用。',
    robots: '管理机器人型号、末端和 topic 要求。',
  };
  return map[page];
}

function SearchPanel({
  title,
  description,
  query,
  placeholder,
  count,
  actions,
  onQueryChange,
}: {
  title: string;
  description?: string;
  query: string;
  placeholder: string;
  count: number;
  actions?: ReactNode;
  onQueryChange: (value: string) => void;
}) {
  return (
    <div className="table-toolbar">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="table-tools">
        <label className="search-field">
          <span>搜索</span>
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={placeholder} />
        </label>
        <span className="result-count">{count} 条</span>
        {actions}
      </div>
    </div>
  );
}

function DataTable<T>({
  rows,
  columns,
  rowKey,
  selectedKey,
  emptyText = '暂无数据',
  onRowClick,
}: {
  rows: T[];
  columns: Array<DataTableColumn<T>>;
  rowKey: (item: T, index: number) => string;
  selectedKey?: string;
  emptyText?: string;
  onRowClick?: (item: T) => void;
}) {
  const gridTemplateColumns = columns.map((column) => column.width || 'minmax(120px, 1fr)').join(' ');
  const tableStyle = { gridTemplateColumns } as const;

  return (
    <div className="data-table-scroll">
      <div className="data-table" role="table" style={tableStyle}>
        <div className="data-table-row data-table-head" role="row">
          {columns.map((column) => (
            <div className={`data-table-cell align-${column.align || 'left'}`} role="columnheader" key={column.key}>
              {column.title}
            </div>
          ))}
        </div>
        {rows.length === 0 ? (
          <div className="table-empty">{emptyText}</div>
        ) : (
          rows.map((row, index) => {
            const key = rowKey(row, index);
            const clickable = Boolean(onRowClick);
            const cells = columns.map((column) => (
              <span
                className={`data-table-cell align-${column.align || 'left'} ${column.allowOverflow ? 'has-popup-control' : ''}`}
                role="cell"
                key={column.key}
              >
                {column.render(row, index)}
              </span>
            ));

            return clickable ? (
              <div
                className={`data-table-row ${selectedKey === key ? 'selected' : ''} ${clickable ? 'clickable' : ''}`}
                role="button"
                tabIndex={0}
                key={key}
                onClick={() => onRowClick?.(row)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onRowClick?.(row);
                  }
                }}
              >
                {cells}
              </div>
            ) : (
              <div className={`data-table-row ${selectedKey === key ? 'selected' : ''}`} role="row" key={key}>
                {cells}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status}`}>{statusText(status)}</span>;
}

function InfoItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="info-item">
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  );
}

function Modal({
  title,
  children,
  panelClassName = '',
  onClose,
}: {
  title: string;
  children: ReactNode;
  panelClassName?: string;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className={`modal-panel ${panelClassName}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-header">
          <h2>{title}</h2>
          <button className="ghost-button" onClick={onClose}>
            关闭
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function MultiEnumInput({
  value,
  options,
  placeholder,
  disabled = false,
  allowCustom = false,
  onChange,
}: {
  value: string[];
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  allowCustom?: boolean;
  onChange: (value: string[]) => void;
}) {
  const uniqueOptions = Array.from(new Set([...options, ...value].filter(Boolean)));
  return (
    <MultiSelectInput
      value={value}
      options={uniqueOptions.map((option) => ({ value: option, label: option }))}
      placeholder={placeholder || '选择枚举值'}
      disabled={disabled}
      emptyText="暂无可选项"
      allowCustom={allowCustom}
      onChange={onChange}
    />
  );
}

function SingleEnumSelect({
  value,
  options,
  placeholder,
  disabled = false,
  allowCustom = false,
  onChange,
}: {
  value: string[];
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  allowCustom?: boolean;
  onChange: (value: string[]) => void;
}) {
  const selectedValue = value[0] || '';
  const uniqueOptions = Array.from(new Set([...options, selectedValue].filter(Boolean)));
  const selectedLabel = selectedValue || placeholder || '请选择';
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 240 });
  const [customValue, setCustomValue] = useState('');

  useEffect(() => {
    if (!open) return;
    function updateMenuPosition() {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(rect.width, 240);
      setMenuStyle({
        left: Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)),
        top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 268)),
        width,
      });
    }
    function closeOnOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    }
    updateMenuPosition();
    document.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('scroll', updateMenuPosition, true);
    window.addEventListener('resize', updateMenuPosition);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('scroll', updateMenuPosition, true);
      window.removeEventListener('resize', updateMenuPosition);
    };
  }, [open]);

  function selectValue(nextValue: string) {
    onChange(nextValue ? [nextValue] : []);
    setOpen(false);
  }

  function addCustomValue() {
    const nextValue = customValue.trim();
    if (!nextValue) return;
    selectValue(nextValue);
    setCustomValue('');
  }

  if (disabled) {
    return (
      <div className="single-enum-select disabled">
        <div className="single-enum-summary">
          <span>{selectedValue || '暂无可选项'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`single-enum-select ${open ? 'open' : ''}`} ref={containerRef}>
      <button
        type="button"
        className="single-enum-summary"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <span className={selectedValue ? '' : 'single-enum-placeholder'}>{selectedLabel}</span>
      </button>
      {open && createPortal(
        <div className="single-enum-menu" ref={menuRef} style={{ top: menuStyle.top, left: menuStyle.left, width: menuStyle.width }}>
          <button type="button" className={`single-enum-option ${!selectedValue ? 'selected' : ''}`} onClick={() => selectValue('')}>
            {placeholder || '请选择'}
          </button>
          {uniqueOptions.map((option) => (
            <button
              type="button"
              className={`single-enum-option ${selectedValue === option ? 'selected' : ''}`}
              key={option}
              onClick={() => selectValue(option)}
            >
              {option}
            </button>
          ))}
          {allowCustom && (
            <div className="single-enum-custom">
              <input
                value={customValue}
                placeholder="新增当前任务 SOP 字段"
                onChange={(event) => setCustomValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addCustomValue();
                  }
                }}
              />
              <button type="button" className="ghost-button" onClick={addCustomValue}>
                新增
              </button>
            </div>
          )}
        </div>
      , document.body)}
    </div>
  );
}

function MultiSelectInput({
  value,
  options,
  placeholder,
  disabled = false,
  emptyText = '暂无可选项',
  allowCustom = false,
  onChange,
}: {
  value: string[];
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  allowCustom?: boolean;
  onChange: (value: string[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 240 });
  const [customValue, setCustomValue] = useState('');
  const selectedOptions = value.map((item) => options.find((option) => option.value === item) || { value: item, label: item });
  const allOptions = uniqueOptions([...options, ...selectedOptions]);
  const summaryText = value.length > 0 ? selectedOptions.map((option) => option.label).join('、') : placeholder || '选择字段';

  useEffect(() => {
    if (!open) return;
    function updateMenuPosition() {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(rect.width, 240);
      setMenuStyle({
        left: Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)),
        top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 268)),
        width,
      });
    }
    function closeOnOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    }
    updateMenuPosition();
    document.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('scroll', updateMenuPosition, true);
    window.addEventListener('resize', updateMenuPosition);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('scroll', updateMenuPosition, true);
      window.removeEventListener('resize', updateMenuPosition);
    };
  }, [open]);

  const toggleValue = (target: string) => {
    if (value.includes(target)) {
      onChange(value.filter((item) => item !== target));
      return;
    }
    onChange([...value, target]);
  };

  const addCustomValue = () => {
    const nextValue = customValue.trim();
    if (!nextValue) return;
    if (!value.includes(nextValue)) {
      onChange([...value, nextValue]);
    }
    setCustomValue('');
  };

  if (disabled) {
    return (
      <div className="multi-select-dropdown disabled">
        <div className="multi-select-summary">
          {selectedOptions.length > 0 ? (
            <span className="multi-select-values">{summaryText}</span>
          ) : (
            <span className="multi-select-placeholder">{emptyText}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`multi-select-dropdown ${open ? 'open' : ''}`} ref={containerRef}>
      <button
        type="button"
        className="multi-select-summary"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        {selectedOptions.length > 0 ? (
          <span className="multi-select-values">{summaryText}</span>
        ) : (
          <span className="multi-select-placeholder">{allOptions.length ? placeholder || '选择字段' : emptyText}</span>
        )}
      </button>
      {open && createPortal(
        <div
          className="multi-select-menu"
          ref={menuRef}
          style={{ top: menuStyle.top, left: menuStyle.left, width: menuStyle.width }}
        >
          {allOptions.length === 0 ? (
            <div className="multi-select-empty">{emptyText}</div>
          ) : (
            allOptions.map((option) => (
              <label className="multi-select-option" key={`${option.category || ''}-${option.value}`}>
                <input type="checkbox" checked={value.includes(option.value)} onChange={() => toggleValue(option.value)} />
                <span>{option.category ? `${option.category} / ${option.label}` : option.label}</span>
              </label>
            ))
          )}
          {allowCustom && (
            <div className="multi-select-custom">
              <input
                value={customValue}
                placeholder="新增当前任务 SOP 字段"
                onChange={(event) => setCustomValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addCustomValue();
                  }
                }}
              />
              <button type="button" className="ghost-button" onClick={addCustomValue}>
                新增
              </button>
            </div>
          )}
        </div>
      , document.body)}
    </div>
  );
}

function fieldOptions(fields: GlobalField[], group: GlobalFieldGroup, includeValues: string[] = []): Option[] {
  const activeOptions = fields
    .filter((field) => field.group === group && field.status === 'active')
    .map(fieldToOption);
  const missingOptions = includeValues
    .filter((value) => value && !activeOptions.some((option) => option.value === value))
    .map((value) => ({ value, label: value }));
  return uniqueOptions([...activeOptions, ...missingOptions]);
}

function fieldToOption(field: GlobalField): Option {
  return {
    value: field.value,
    label: field.label || field.value,
    description: field.description,
  };
}

function uniqueOptions(options: Option[]): Option[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.category || ''}:${option.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function RequirementPage({
  data,
  globalFields,
  selectedRequirement,
  selectedVersion,
  detailOpen,
  onDetailOpenChange,
  onSelectRequirement,
  onSelectVersion,
  onCreate,
  onSave,
  onDeleteVersion,
  onConfirm,
  onExport,
  onRun,
  attachmentStorageStatus,
  onRequirementsChange,
  onOpenSubscene,
}: {
  data: AppData;
  globalFields: GlobalField[];
  selectedRequirement?: Requirement;
  selectedVersion?: RequirementVersion;
  detailOpen: boolean;
  onDetailOpenChange: (open: boolean) => void;
  onSelectRequirement: (id: string) => void;
  onSelectVersion: (version: string) => void;
  onCreate: () => Promise<void>;
  onSave: (patch: Partial<RequirementVersion>) => Promise<void>;
  onDeleteVersion: () => Promise<void>;
  onConfirm: () => Promise<void>;
  onExport: () => Promise<ExportResult | undefined>;
  onRun: <T>(action: () => Promise<T>, success: string) => Promise<T | undefined>;
  attachmentStorageStatus: AttachmentStorageStatus;
  onRequirementsChange: (requirements: Requirement[]) => void;
  onOpenSubscene: (code: string, version: string) => void;
}) {
  const [yamlPreview, setYamlPreview] = useState('');
  const [exportPath, setExportPath] = useState('');
  const [yamlCopyStatus, setYamlCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [requirementQuery, setRequirementQuery] = useState('');
  const [subsceneQuery, setSubsceneQuery] = useState('');
  const [taskSopPickerItemId, setTaskSopPickerItemId] = useState('');
  const [candidateVersionSelections, setCandidateVersionSelections] = useState<Record<string, string>>({});
  const [attachmentUpload, setAttachmentUpload] = useState<{ fileName: string; progress: number } | null>(null);

  const candidateSubscenes = useMemo(() => {
    const items: CandidateSubsceneOption[] = [];
    for (const scene of data.scenes) {
      for (const subscene of scene.subscenes) {
        const sortedVersions = [...subscene.versions].reverse();
        const defaultVersion = sortedVersions[0] || latest(subscene.versions);
        const selectedVersionName = candidateVersionSelections[subscene.code] || defaultVersion.version;
        const selectedCandidateVersion = subscene.versions.find((item) => item.version === selectedVersionName) || defaultVersion;
        items.push({
          sceneId: scene.id,
          sceneName: scene.name,
          code: subscene.code,
          name: subscene.name,
          versions: sortedVersions,
          selectedVersion: selectedCandidateVersion,
        });
      }
    }
    return items.filter(
      (item) =>
        !subsceneQuery ||
        item.code.toLowerCase().includes(subsceneQuery.toLowerCase()) ||
        item.name.toLowerCase().includes(subsceneQuery.toLowerCase()) ||
        item.selectedVersion.title.toLowerCase().includes(subsceneQuery.toLowerCase()) ||
        item.sceneName.toLowerCase().includes(subsceneQuery.toLowerCase()),
    );
  }, [data.scenes, subsceneQuery, candidateVersionSelections]);

  const filteredRequirements = data.requirements.filter((requirement) => {
    const current = latest(requirement.versions);
    const customer = data.customers.find((item) => item.id === current.customerId);
    const robot = data.robotModels.find((item) => item.id === current.robotModelId);
    return matchesQuery(requirementQuery, [
      requirement.id,
      current.title,
      current.projectName,
      current.status,
      current.version,
      customer?.name,
      robot?.model,
      robot?.brand,
    ]);
  });
  const taskSopPickerItem = selectedVersion?.selectedSubscenes.find((item) => productionItemKey(item) === taskSopPickerItemId);
  const selectedSubsceneGroups = selectedVersion
    ? Array.from(
        selectedVersion.selectedSubscenes.reduce((groups, item) => {
          const sceneName = productionItemSceneName(item) || '未选择场景';
          const rows = groups.get(sceneName) || [];
          rows.push(item);
          groups.set(sceneName, rows);
          return groups;
        }, new Map<string, RequirementVersion['selectedSubscenes']>()),
      )
    : [];
  const selectedSubsceneDurationTotal =
    selectedVersion?.selectedSubscenes.reduce((total, item) => total + (Number(item.targetDurationHours) || 0), 0) || 0;
  const durationDelta = selectedVersion ? selectedSubsceneDurationTotal - (Number(selectedVersion.requiredDurationHours) || 0) : 0;
  const missingSelectedSubscenes =
    selectedVersion?.selectedSubscenes.filter((item) => !taskSopVersion(item) || !findTaskSop(data.scenes, item)) || [];
  const unconfirmedSelectedSubscenes =
    selectedVersion?.selectedSubscenes.filter((item) => {
      const target = findTaskSop(data.scenes, item);
      return (target?.version?.status || taskSopStatus(item)) !== 'confirmed';
    }) || [];

  const requirementColumns: Array<DataTableColumn<Requirement>> = [
    {
      key: 'title',
      title: '需求名称',
      width: 'minmax(160px, 1.6fr)',
      render: (requirement) => latest(requirement.versions).title,
    },
    {
      key: 'customer',
      title: '客户',
      width: 'minmax(80px, 0.8fr)',
      render: (requirement) =>
        data.customers.find((item) => item.id === latest(requirement.versions).customerId)?.name || '-',
    },
    {
      key: 'project',
      title: '项目名称',
      width: 'minmax(100px, 1fr)',
      render: (requirement) => latest(requirement.versions).projectName || '-',
    },
    {
      key: 'status',
      title: '状态',
      width: '78px',
      render: (requirement) => <StatusBadge status={latest(requirement.versions).status} />,
    },
    {
      key: 'version',
      title: '版本',
      width: '72px',
      render: (requirement) => `v${latest(requirement.versions).version}`,
    },
    {
      key: 'subscenes',
      title: '生产需求项',
      width: '88px',
      align: 'right',
      render: (requirement) => latest(requirement.versions).selectedSubscenes.length,
    },
    {
      key: 'duration',
      title: '总时长',
      width: '76px',
      align: 'right',
      render: (requirement) => `${latest(requirement.versions).requiredDurationHours || 0} h`,
    },
    {
      key: 'deadline',
      title: '截止日期',
      width: '112px',
      render: (requirement) => formatShortDate(latest(requirement.versions).deadline),
    },
    {
      key: 'action',
      title: '操作',
      width: '54px',
      render: (requirement) => (
        <button
          className="text-button"
          onClick={(event) => {
            event.stopPropagation();
            openRequirementDetail(requirement.id);
          }}
        >
          查看
        </button>
      ),
    },
  ];

  const selectedSubsceneColumns: Array<DataTableColumn<RequirementVersion['selectedSubscenes'][number]>> = [
    {
      key: 'title',
      title: '生产需求项',
      width: 'minmax(190px, 1.2fr)',
      render: (item) => (
        <InlineTextInput
          disabled={readonly}
          value={productionItemTitle(item)}
          placeholder="需求项名称"
          onCommit={(title) => {
            if (readonly || !selectedVersion) return;
            const selectedSubscenes = selectedVersion.selectedSubscenes.map((current) =>
              isSameProductionItem(current, item) ? { ...current, title } : current,
            );
            void onSave({ selectedSubscenes: selectedSubscenes.map(stripSelectedTaskSopCode) });
          }}
        />
      ),
    },
    {
      key: 'description',
      title: '描述',
      width: '160px',
      render: (item) => (
        <LongTextDialogEditor
          title="生产需求项描述"
          value={item.description || ''}
          disabled={readonly}
          placeholder="填写客户对这个需求项的描述"
          onChange={(description) => {
            if (readonly || !selectedVersion) return;
            const selectedSubscenes = selectedVersion.selectedSubscenes.map((current) =>
              isSameProductionItem(current, item) ? { ...current, description } : current,
            );
            void onSave({ selectedSubscenes: selectedSubscenes.map(stripSelectedTaskSopCode) });
          }}
        />
      ),
    },
    {
      key: 'scene',
      title: '场景',
      width: '150px',
      render: (item) => (
        <select
          value={productionItemSceneName(item)}
          disabled={readonly}
          onChange={(event) => {
            if (readonly || !selectedVersion) return;
            const sceneName = event.target.value;
            const selectedSubscenes = selectedVersion.selectedSubscenes.map((current) =>
              isSameProductionItem(current, item) ? { ...current, sceneName } : current,
            );
            void onSave({
              requestedScenes: Array.from(new Set(selectedSubscenes.map((current) => productionItemSceneName(current)).filter(Boolean))),
              selectedSubscenes: selectedSubscenes.map(stripSelectedTaskSopCode),
            });
          }}
        >
          <option value="">未选择</option>
          {data.scenes.map((scene) => (
            <option value={scene.name} key={scene.id}>
              {scene.name}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: 'taskSop',
      title: '任务 SOP',
      width: 'minmax(180px, 1fr)',
      render: (item) => taskSopLabel(item) || <span className="muted-text">未选择任务 SOP</span>,
    },
    { key: 'version', title: 'SOP 版本', width: '90px', render: (item) => (taskSopVersion(item) ? `v${taskSopVersion(item)}` : '-') },
    {
      key: 'status',
      title: '状态',
      width: '96px',
      render: (item) => {
        const target = findTaskSop(data.scenes, item);
        const status = target?.version?.status || taskSopStatus(item);
        return status ? <StatusBadge status={status} /> : '未选择';
      },
    },
    {
      key: 'duration',
      title: '目标采集时长',
      width: '160px',
      render: (item) => (
        <span className="inline-edit">
          <InlineNumberInput
            disabled={readonly}
            value={item.targetDurationHours}
            onCommit={(targetDurationHours) => {
              if (readonly) return;
              const selectedSubscenes = selectedVersion?.selectedSubscenes.map((current) =>
                isSameProductionItem(current, item)
                  ? { ...current, targetDurationHours }
                  : current,
              );
              if (selectedSubscenes) void onSave({ selectedSubscenes: selectedSubscenes.map(stripSelectedTaskSopCode) });
            }}
          />
          h
        </span>
      ),
    },
    {
      key: 'count',
      title: '目标采集数量',
      width: '210px',
      render: (item) => (
        <span className="inline-edit">
          <InlineNumberInput
            className="target-count-input"
            disabled={readonly}
            value={item.targetCollectionCount || 0}
            onCommit={(targetCollectionCount) => {
              if (readonly) return;
              const selectedSubscenes = selectedVersion?.selectedSubscenes.map((current) =>
                isSameProductionItem(current, item)
                  ? { ...current, targetCollectionCount }
                  : current,
              );
              if (selectedSubscenes) void onSave({ selectedSubscenes: selectedSubscenes.map(stripSelectedTaskSopCode) });
            }}
          />
          条
        </span>
      ),
    },
    {
      key: 'action',
      title: '操作',
      width: '186px',
      render: (item) => (
        <span className="table-action-row">
          <button
            className="text-button"
            disabled={readonly}
            onClick={() => setTaskSopPickerItemId(productionItemKey(item))}
          >
            选择 SOP
          </button>
          <button
            className="text-button"
            disabled={!findTaskSop(data.scenes, item)}
            onClick={() => {
              const target = findTaskSop(data.scenes, item);
              const version = taskSopVersion(item);
              if (target && version) onOpenSubscene(target.subscene.code, version);
            }}
          >
            查看
          </button>
          <button
            className="text-button danger"
            disabled={readonly}
            onClick={() => {
              if (readonly || !selectedVersion) return;
              void onSave({
                selectedSubscenes: selectedVersion.selectedSubscenes.filter(
                  (current) => !isSameProductionItem(current, item),
                ).map(stripSelectedTaskSopCode),
              });
            }}
          >
            移除
          </button>
        </span>
      ),
    },
  ];

  const candidateSubsceneColumns: Array<DataTableColumn<CandidateSubsceneOption>> = [
    { key: 'name', title: '任务 SOP', width: 'minmax(180px, 1.4fr)', render: (item) => item.selectedVersion.title || item.name },
    { key: 'scene', title: '场景', width: '140px', render: (item) => item.sceneName },
    {
      key: 'version',
      title: '版本',
      width: '130px',
      render: (item) => (
        <select
          value={item.selectedVersion.version}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            event.stopPropagation();
            setCandidateVersionSelections((current) => ({ ...current, [item.code]: event.target.value }));
          }}
        >
          {item.versions.map((version) => (
            <option value={version.version} key={version.version}>
              v{version.version}
            </option>
          ))}
        </select>
      ),
    },
    { key: 'status', title: '状态', width: '96px', render: (item) => <StatusBadge status={item.selectedVersion.status} /> },
    {
      key: 'importStatus',
      title: '选择状态',
      width: '100px',
      render: (item) => (taskSopPickerItem && isSameTaskSopCandidate(taskSopPickerItem, item) ? '当前选择' : '可选择'),
    },
  ];

  function openRequirementDetail(id: string) {
    onSelectRequirement(id);
    setYamlPreview('');
    setExportPath('');
    onDetailOpenChange(true);
  }

  async function createRequirementAndOpen() {
    await onCreate();
    setYamlPreview('');
    setExportPath('');
    onDetailOpenChange(true);
  }

  function closeRequirementDetail() {
    setYamlPreview('');
    setExportPath('');
    onDetailOpenChange(false);
  }

  if (!detailOpen || !selectedRequirement || !selectedVersion) {
    return (
      <div className="page-stack">
        <section className="panel table-panel">
          <SearchPanel
            title="需求列表"
            description="按需求名称、客户、项目、状态或版本搜索，点击行进入详情页"
            query={requirementQuery}
            placeholder="搜索需求名称、客户、项目"
            count={filteredRequirements.length}
            onQueryChange={setRequirementQuery}
            actions={
              <button className="primary-button" onClick={() => void createRequirementAndOpen()}>
                新建需求
              </button>
            }
          />
          <DataTable
            rows={filteredRequirements}
            columns={requirementColumns}
            rowKey={(requirement) => requirement.id}
            emptyText="还没有客户需求"
            onRowClick={(requirement) => openRequirementDetail(requirement.id)}
          />
        </section>
      </div>
    );
  }

  const readonly = selectedVersion.status === 'confirmed';
  const selectedAllowedOperations = selectedVersion.allowedOperations.map((item) => item.operation);
  const selectedAcceptableOperations = (selectedVersion.acceptableOperations || []).map((item) => item.operation);
  const selectedForbiddenOperations = selectedVersion.forbiddenOperations.flatMap((group) =>
    group.operations.map((item) => (group.category ? `${group.category}/${item.operation}` : item.operation)),
  );
  const forbiddenOptions = fieldOptions(
    globalFields,
    'forbidden_operation',
    selectedForbiddenOperations,
  );
  const allowedOperationOptions = fieldOptions(globalFields, 'allowed_operation', selectedAllowedOperations);
  const acceptableOperationOptions = fieldOptions(globalFields, 'acceptable_operation', selectedAcceptableOperations);
  const selectedAnnotationAllowedOperations = selectedVersion.annotation.allowedOperations?.map((item) => item.operation) || [];
  const selectedAnnotationForbiddenOperations = selectedVersion.annotation.forbiddenOperations?.map((item) => item.operation) || [];
  const annotationAllowedOptions = fieldOptions(globalFields, 'annotation_allowed_operation', selectedAnnotationAllowedOperations);
  const annotationForbiddenOptions = fieldOptions(globalFields, 'annotation_forbidden_operation', selectedAnnotationForbiddenOperations);
  const yamlDownloadFileName = `${safeFileName(selectedVersion.title)}-${selectedVersion.version}.yaml`;

  async function generateYamlPreview(): Promise<ExportResult | undefined> {
    const result = await onExport();
    if (result) {
      setYamlPreview(result.yaml);
      setExportPath(result.path);
    }
    return result;
  }

  async function downloadYaml() {
    const result = await generateYamlPreview();
    if (!result) return;
    const blob = new Blob([result.yaml], { type: 'application/x-yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = yamlDownloadFileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function copyYamlPreview() {
    const yaml = yamlPreview || (await generateYamlPreview())?.yaml;
    if (!yaml) return;
    const copied = await copyTextToClipboard(yaml);
    setYamlCopyStatus(copied ? 'copied' : 'failed');
    window.setTimeout(() => setYamlCopyStatus('idle'), 1600);
  }

  function createDraftFromCurrentVersion() {
    void onSave({});
  }

  function addProductionRequirementItem() {
    if (!selectedVersion || readonly) return;
    const usedIds = selectedVersion.selectedSubscenes.map((item) => (item.id || '').replace(/^pri_/i, '')).filter(Boolean);
    const id = `pri_${randomShortCode(usedIds, 6).toLowerCase()}`;
    const nextItems = [
      ...selectedVersion.selectedSubscenes,
      {
        id,
        title: `生产需求项 ${selectedVersion.selectedSubscenes.length + 1}`,
        description: '',
        sceneName: '',
        targetDurationHours: 0,
        targetCollectionCount: 0,
      },
    ];
    void onSave({
      selectedSubscenes: nextItems.map(stripSelectedTaskSopCode),
    });
  }

  function selectTaskSopForProductionItem(candidate: CandidateSubsceneOption) {
    if (!selectedVersion || readonly || !taskSopPickerItem) return;
    const ref = candidateTaskSopReference(candidate);
    const selectedSubscenes = selectedVersion.selectedSubscenes.map((current) =>
      isSameProductionItem(current, taskSopPickerItem)
        ? {
            ...current,
            sceneName: current.sceneName || ref.sceneName,
            subsceneName: ref.title,
            version: ref.version,
            taskSop: ref,
          }
        : current,
    );
    void onSave({
      requestedScenes: Array.from(new Set(selectedSubscenes.map((current) => productionItemSceneName(current)).filter(Boolean))),
      selectedSubscenes: selectedSubscenes.map(stripSelectedTaskSopCode),
    });
    setTaskSopPickerItemId('');
  }

  async function uploadRequirementAttachment(file: File) {
    if (!selectedRequirement || !selectedVersion || readonly) return;
    if (file.size > 1024 * 1024 * 1024) {
      window.alert('单个附件不能超过 1G');
      return;
    }
    let uploadInit: AttachmentUploadInit | undefined;
    try {
      setAttachmentUpload({ fileName: file.name, progress: 0 });
      uploadInit = await api.initAttachmentUpload(selectedRequirement.id, selectedVersion.version, file);
      const parts: AttachmentUploadPart[] = [];
      const totalParts = Math.ceil(file.size / uploadInit.partSize);
      for (let index = 0; index < totalParts; index += 1) {
        const start = index * uploadInit.partSize;
        const end = Math.min(file.size, start + uploadInit.partSize);
        const part = await api.uploadAttachmentPart(
          selectedRequirement.id,
          selectedVersion.version,
          uploadInit.uploadId,
          uploadInit.storageKey,
          index + 1,
          file.slice(start, end, file.type || 'application/octet-stream'),
        );
        parts.push({ partNumber: index + 1, etag: part.etag });
        setAttachmentUpload({ fileName: file.name, progress: Math.round(((index + 1) / totalParts) * 100) });
      }
      await api.completeAttachmentUpload(
        selectedRequirement.id,
        selectedVersion.version,
        uploadInit.attachmentId,
        uploadInit.uploadId,
        uploadInit.storageKey,
        parts,
      );
      const nextData = await api.data();
      onRequirementsChange(nextData.requirements);
      setYamlPreview('');
      setExportPath('');
    } catch (error) {
      if (uploadInit) {
        await api.abortAttachmentUpload(
          selectedRequirement.id,
          selectedVersion.version,
          uploadInit.attachmentId,
          uploadInit.uploadId,
          uploadInit.storageKey,
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      setAttachmentUpload(null);
    }
  }

  async function downloadRequirementAttachment(attachment: RequirementAttachment) {
    await downloadStoredAttachment(attachment);
  }

  function saveAllowedOperations(operations: string[]) {
    void onSave({
      allowedOperations: operations.map((operation) => {
        const option = allowedOperationOptions.find((item) => item.value === operation);
        return { operation, note: option?.description || '' };
      }),
    });
  }

  function saveAcceptableOperations(operations: string[]) {
    void onSave({
      acceptableOperations: operations.map((operation) => {
        const option = acceptableOperationOptions.find((item) => item.value === operation);
        return { operation, note: option?.description || '' };
      }),
    });
  }

  function saveForbiddenOperations(operations: string[]) {
    void onSave({ forbiddenOperations: forbiddenGroupsFromKeys(operations, forbiddenOptions) });
  }

  function saveAnnotationAllowedOperations(operations: string[]) {
    if (!selectedVersion) return;
    void onSave({
      annotation: {
        ...selectedVersion.annotation,
        allowedOperations: operations.map((operation) => {
          const option = annotationAllowedOptions.find((item) => item.value === operation);
          return { operation, note: option?.description || '' };
        }),
      },
    });
  }

  function saveAnnotationForbiddenOperations(operations: string[]) {
    if (!selectedVersion) return;
    void onSave({
      annotation: {
        ...selectedVersion.annotation,
        forbiddenOperations: operations.map((operation) => {
          const option = annotationForbiddenOptions.find((item) => item.value === operation);
          return { operation, note: option?.description || '' };
        }),
      },
    });
  }

  const taskSopPickerModal = taskSopPickerItem && (
    <Modal title={`为“${productionItemTitle(taskSopPickerItem)}”选择任务 SOP`} onClose={() => setTaskSopPickerItemId('')}>
      <SearchPanel
        title="任务 SOP 库"
        description="按名称或场景搜索，点击行选择这个生产需求项要使用的任务 SOP 版本"
        query={subsceneQuery}
        placeholder="搜索洗漱台整理或场景名称"
        count={candidateSubscenes.length}
        onQueryChange={setSubsceneQuery}
      />
      <DataTable
        rows={candidateSubscenes}
        columns={candidateSubsceneColumns}
        rowKey={candidateTaskSopKey}
        emptyText="没有匹配的任务 SOP"
        onRowClick={selectTaskSopForProductionItem}
      />
    </Modal>
  );

  return (
    <>
      <div className="detail-page">
        <div className="detail-page-toolbar">
          <button className="ghost-button" onClick={closeRequirementDetail}>
            返回需求列表
          </button>
          <span>客户需求 / v{selectedVersion.version}</span>
        </div>
        <section className="panel detail-panel">
          <div className="panel-header">
          <div>
            <h2>{selectedVersion.title}</h2>
            <p>
              v{selectedVersion.version} · {statusText(selectedVersion.status)}
            </p>
          </div>
          <div className="button-row">
            <label className="version-select">
              <span>版本</span>
              <select value={selectedVersion.version} onChange={(event) => onSelectVersion(event.target.value)}>
                {selectedRequirement.versions.map((version) => (
                  <option value={version.version} key={version.version}>
                    v{version.version} · {statusText(version.status)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="ghost-button"
              disabled={missingSelectedSubscenes.length > 0}
              onClick={() => void downloadYaml()}
            >
              导出 YAML
            </button>
            <button
              className="ghost-button"
              onClick={() => exportReportAsPdf(buildRequirementPdfReport(data, selectedRequirement, selectedVersion, attachmentStorageStatus.publicBaseUrl))}
            >
              导出 PDF
            </button>
            {selectedVersion.status === 'confirmed' ? (
              <button className="primary-button" onClick={createDraftFromCurrentVersion}>
                编辑为草稿
              </button>
            ) : (
              <>
                <button className="ghost-button danger" onClick={() => void onDeleteVersion()}>
                  删除草稿
                </button>
                <button
                  className="primary-button"
                  disabled={unconfirmedSelectedSubscenes.length > 0}
                  title={unconfirmedSelectedSubscenes.length > 0 ? '有任务 SOP 还没有确认，不能确认需求' : undefined}
                  onClick={() => void onConfirm()}
                >
                  确认版本
                </button>
              </>
            )}
          </div>
          </div>

          {readonly && <div className="notice info">当前版本已确认，点击“编辑为草稿”会复制出新的草稿版本。</div>}
          {!readonly && unconfirmedSelectedSubscenes.length > 0 && (
            <div className="notice warning">
              有 {unconfirmedSelectedSubscenes.length} 个生产需求项未选择任务 SOP，或选择的任务 SOP 还没有确认，不能确认需求：
              {unconfirmedSelectedSubscenes
                .map((item) => {
                  const label = taskSopLabel(item);
                  const version = taskSopVersion(item);
                  return `${productionItemTitle(item)}${label ? ` / ${label} v${version || '-'}` : ' / 未选择任务 SOP'}`;
                })
                .join('；')}
            </div>
          )}

          <div className="requirement-sections">
            <section className="requirement-section">
              <div className="requirement-section-header">
                <h3>基础信息</h3>
                <p>客户、项目、机器人和计划信息</p>
              </div>
              <div className="requirement-section-grid">
                <CommitField
                  label="需求名称"
                  value={selectedVersion.title}
                  disabled={readonly}
                  onChange={(title) => void onSave({ title })}
                />
                <Field
                  label="项目名称"
                  value={selectedVersion.projectName}
                  disabled={readonly}
                  onChange={(projectName) => void onSave({ projectName })}
                />
                <SelectField
                  label="客户"
                  value={selectedVersion.customerId}
                  options={data.customers.map((item) => ({ value: item.id, label: item.name }))}
                  disabled={readonly}
                  onChange={(customerId) => void onSave({ customerId })}
                />
                <SelectField
                  label="机器人型号"
                  value={selectedVersion.robotModelId}
                  options={data.robotModels.map((item) => ({ value: item.id, label: `${item.brand} ${item.model}` }))}
                  disabled={readonly}
                  onChange={(robotModelId) => void onSave({ robotModelId })}
                />
                <Field
                  label="截止日期"
                  type="date"
                  value={selectedVersion.deadline}
                  disabled={readonly}
                  onChange={(deadline) => void onSave({ deadline })}
                />
                <Field
                  label="总目标时长（小时）"
                  type="number"
                  value={String(selectedVersion.requiredDurationHours)}
                  disabled={readonly}
                  onChange={(requiredDurationHours) => void onSave({ requiredDurationHours: Number(requiredDurationHours) })}
                />
              </div>
            </section>

            <section className="requirement-section">
              <div className="requirement-section-header">
                <h3>交付 / 标注 / 质检</h3>
                <p>数据交付方式、标注范围和客户抽检策略</p>
              </div>
              <div className="requirement-section-grid">
                <SelectField
                  label="交付形式"
                  value={selectedVersion.delivery.method}
                  options={fieldOptions(globalFields, 'delivery_method', [selectedVersion.delivery.method]).map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  disabled={readonly}
                  onChange={(method) => void onSave({ delivery: { ...selectedVersion.delivery, method } })}
                />
                <Field
                  label="数据交付结构"
                  value={selectedVersion.delivery.dataStructureUrl}
                  disabled={readonly}
                  onChange={(dataStructureUrl) => void onSave({ delivery: { ...selectedVersion.delivery, dataStructureUrl } })}
                />
                <MultiSelectField
                  label="交付数据"
                  value={selectedVersion.delivery.formats}
                  options={fieldOptions(globalFields, 'delivery_format', selectedVersion.delivery.formats)}
                  disabled={readonly}
                  onChange={(formats) => void onSave({ delivery: { ...selectedVersion.delivery, formats } })}
                />
                <MultiSelectField
                  label="交付语言"
                  value={selectedVersion.delivery.languages.map((item) => `${item.code}:${item.name}`)}
                  options={fieldOptions(
                    globalFields,
                    'delivery_language',
                    selectedVersion.delivery.languages.map((item) => `${item.code}:${item.name}`),
                  )}
                  disabled={readonly}
                  onChange={(value) =>
                    void onSave({
                      delivery: {
                        ...selectedVersion.delivery,
                        languages: value.map((item) => {
                          const [code, name = code] = item.split(':');
                          return { code, name };
                        }),
                      },
                    })
                  }
                />
                <SelectField
                  label="是否需要标注"
                  value={selectedVersion.annotation.required ? '需要' : '不需要'}
                  options={['需要', '不需要'].map((item) => ({ value: item, label: item }))}
                  disabled={readonly}
                  onChange={(value) => void onSave({ annotation: { ...selectedVersion.annotation, required: value === '需要' } })}
                />
                <SelectField
                  label="客户抽检策略"
                  value={selectedVersion.qualityInspection.samplingPolicy}
                  options={fieldOptions(globalFields, 'sampling_policy', [selectedVersion.qualityInspection.samplingPolicy]).map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  disabled={readonly}
                  onChange={(samplingPolicy) =>
                    void onSave({ qualityInspection: { ...selectedVersion.qualityInspection, samplingPolicy } })
                  }
                />
                <div className="field wide">
                  <span>标注类型</span>
                  <MultiSelectInput
                    value={selectedVersion.annotation.types}
                    options={fieldOptions(globalFields, 'annotation_type', selectedVersion.annotation.types)}
                    disabled={readonly}
                    onChange={(types) => void onSave({ annotation: { ...selectedVersion.annotation, types } })}
                  />
                </div>
              </div>
            </section>

            <section className="requirement-section">
              <div className="requirement-section-header">
                <h3>说明补充</h3>
                <p>需求背景、topic、随机性和补充附件</p>
              </div>
              <div className="requirement-notes-grid">
                <TextArea
                  label="数据用途/业务目标"
                  value={selectedVersion.businessGoal}
                  disabled={readonly}
                  onChange={(businessGoal) => void onSave({ businessGoal })}
                />
                <TextArea
                  label="客户额外 topic 要求"
                  value={selectedVersion.extraTopicRequirementsText || ''}
                  disabled={readonly}
                  onChange={(extraTopicRequirementsText) => void onSave({ extraTopicRequirementsText })}
                />
                <TextArea
                  label="全局随机性要求"
                  value={selectedVersion.globalRandomizationRequirements || ''}
                  disabled={readonly}
                  onChange={(globalRandomizationRequirements) => void onSave({ globalRandomizationRequirements })}
                />
                <AttachmentField
                  title="客户附件"
                  hint="单个附件不超过 1G，支持分片上传"
                  attachments={selectedVersion.attachments || []}
                  disabled={readonly}
                  storageStatus={attachmentStorageStatus}
                  upload={attachmentUpload}
                  onUpload={(file) => onRun(() => uploadRequirementAttachment(file), '附件已上传').then(() => undefined)}
                  onDownload={(attachment) => onRun(() => downloadRequirementAttachment(attachment), '附件已下载').then(() => undefined)}
                  onDelete={async (attachmentId) => {
                    if (!selectedRequirement) return;
                    const result = await onRun(
                      () => api.deleteAttachment(selectedRequirement.id, selectedVersion.version, attachmentId),
                      '附件已删除',
                    );
                    if (result) onRequirementsChange(result);
                  }}
                />
                <TextArea
                  label="其他补充说明"
                  value={selectedVersion.additionalNotes || ''}
                  disabled={readonly}
                  onChange={(additionalNotes) => void onSave({ additionalNotes })}
                />
              </div>
            </section>

            <section className="requirement-section">
              <div className="requirement-section-header">
                <h3>操作要求</h3>
                <p>客户需求层面的采集和标注操作约束</p>
              </div>
              <div className="requirement-operation-sections">
                <div className="operation-category">
                  <div className="operation-category-header">
                    <h4>采集操作要求</h4>
                  </div>
                  <div className="requirement-operation-grid">
                    <OperationRequirementGroup
                      title="采集操作要求"
                      value={selectedAllowedOperations}
                      options={allowedOperationOptions}
                      readOnly={readonly}
                      onChange={saveAllowedOperations}
                    />
                    <OperationRequirementGroup
                      title="不完美但可接受的采集操作"
                      value={selectedAcceptableOperations}
                      options={acceptableOperationOptions}
                      readOnly={readonly}
                      onChange={saveAcceptableOperations}
                    />
                    <OperationRequirementGroup
                      title="采集禁止操作"
                      value={selectedForbiddenOperations}
                      options={forbiddenOptions}
                      readOnly={readonly}
                      onChange={saveForbiddenOperations}
                    />
                  </div>
                </div>
                <div className="operation-category">
                  <div className="operation-category-header">
                    <h4>标注操作要求</h4>
                  </div>
                  <div className="requirement-operation-grid annotation-operation-grid">
                    <OperationRequirementGroup
                      title="标注操作要求"
                      value={selectedAnnotationAllowedOperations}
                      options={annotationAllowedOptions}
                      readOnly={readonly}
                      onChange={saveAnnotationAllowedOperations}
                    />
                    <OperationRequirementGroup
                      title="标注禁止操作"
                      value={selectedAnnotationForbiddenOperations}
                      options={annotationForbiddenOptions}
                      readOnly={readonly}
                      onChange={saveAnnotationForbiddenOperations}
                    />
                  </div>
                </div>
              </div>
            </section>
          </div>

        <div className="embedded-table">
          <div className="embedded-table-header">
            <div>
              <h3>生产需求项</h3>
              <p>先维护客户要做的需求项，再为每条需求项选择对应的任务 SOP 版本</p>
            </div>
            <div className="button-row">
              <span className="result-count">{selectedVersion.selectedSubscenes.length} 条</span>
              <button className="primary-button" disabled={readonly} onClick={addProductionRequirementItem}>
                添加生产需求项
              </button>
            </div>
          </div>
          {durationDelta !== 0 && (
            <div className="notice warning compact-notice">
              总目标时长 {Number(selectedVersion.requiredDurationHours) || 0} h，生产需求项目标时长合计{' '}
              {selectedSubsceneDurationTotal} h，{durationDelta > 0 ? '超出' : '还差'} {Math.abs(durationDelta)} h。
            </div>
          )}
          {missingSelectedSubscenes.length > 0 && (
            <div className="notice error compact-notice">
              有 {missingSelectedSubscenes.length} 个生产需求项未选择任务 SOP，或引用的任务 SOP 版本未找到，修正后才能导出 YAML。
            </div>
          )}
          {selectedSubsceneGroups.length === 0 ? (
            <div className="table-empty">当前客户需求还没有生产需求项</div>
          ) : (
            <div className="subscene-group-list">
              {selectedSubsceneGroups.map(([sceneName, rows]) => (
                <section className="subscene-group" key={sceneName}>
                  <div className="subscene-group-header">
                    <strong>{sceneName}</strong>
                    <span>{rows.length} 个生产需求项</span>
                  </div>
                  <DataTable
                    rows={rows}
                    columns={selectedSubsceneColumns}
                    rowKey={productionItemKey}
                    emptyText="当前场景下没有生产需求项"
                  />
                </section>
              ))}
            </div>
          )}
        </div>

          <div className="yaml-preview">
          <div className="section-title yaml-preview-title">
            <div>
              <h3>YAML 预览</h3>
              {exportPath && <span>{exportPath}</span>}
            </div>
            <div className="button-row">
              <button
                className="ghost-button"
                disabled={missingSelectedSubscenes.length > 0}
                onClick={() => void generateYamlPreview()}
              >
                生成预览
              </button>
              <button
                className="ghost-button"
                disabled={missingSelectedSubscenes.length > 0}
                onClick={() => void copyYamlPreview()}
              >
                {yamlCopyStatus === 'copied' ? '已复制' : yamlCopyStatus === 'failed' ? '复制失败' : '复制'}
              </button>
            </div>
          </div>
          <pre>{yamlPreview || '点击“生成预览”后在这里预览。'}</pre>
          </div>
        </section>
      </div>
      {taskSopPickerModal}
    </>
  );
}

function ScenePage({
  globalFields,
  materials,
  scenes,
  selectedSceneId,
  selectedSubsceneCode,
  selectedVersion,
  detailOpen,
  onSelectScene,
  onSelectSubscene,
  onSelectVersion,
  onDetailOpenChange,
  onSaveScene,
  onSaveSubscene,
  onDeleteSubsceneVersion,
  onConfirmSubscene,
  onRun,
  attachmentStorageStatus,
  onScenesChange,
  returnToRequirement,
  onReturnToRequirement,
  onClearReturnToRequirement,
}: {
  globalFields: GlobalField[];
  materials: Material[];
  scenes: Scene[];
  selectedSceneId: string;
  selectedSubsceneCode: string;
  selectedVersion: string;
  detailOpen: boolean;
  onSelectScene: (id: string) => void;
  onSelectSubscene: (code: string) => void;
  onSelectVersion: (version: string) => void;
  onDetailOpenChange: (open: boolean) => void;
  onSaveScene: (scene: Scene) => Promise<void>;
  onSaveSubscene: (sceneId: string, code: string, version: VersionPatch<SubsceneVersion>) => Promise<void>;
  onDeleteSubsceneVersion: (sceneId: string, code: string, version: string) => Promise<void>;
  onConfirmSubscene: (sceneId: string, code: string, version: string) => Promise<void>;
  onRun: <T>(action: () => Promise<T>, success: string) => Promise<T | undefined>;
  attachmentStorageStatus: AttachmentStorageStatus;
  onScenesChange: (scenes: Scene[]) => void;
  returnToRequirement: RequirementReturnTarget | null;
  onReturnToRequirement: () => void;
  onClearReturnToRequirement: () => void;
}) {
  const [sceneQuery, setSceneQuery] = useState('');
  const [subsceneQuery, setSubsceneQuery] = useState('');
  const [materialQuery, setMaterialQuery] = useState('');
  const [materialPickerOpen, setMaterialPickerOpen] = useState(false);
  const [sceneEditorOpen, setSceneEditorOpen] = useState(false);
  const [sceneDraft, setSceneDraft] = useState<Scene>(emptyScene());
  const [attachmentUpload, setAttachmentUpload] = useState<{ fileName: string; progress: number } | null>(null);
  const scene = scenes.find((item) => item.id === selectedSceneId) || scenes[0];
  const subscene = scene?.subscenes.find((item) => item.code === selectedSubsceneCode) || scene?.subscenes[0];
  const version = subscene
    ? subscene.versions.find((item) => item.version === selectedVersion) || latest(subscene.versions)
    : undefined;
  const canEditVersion = version?.status === 'draft';
  const canEditSubsceneTitle = Boolean(version && canEditVersion && version.version === '0.0.1' && version.status === 'draft');
  const canEditDescription = Boolean(version && canEditVersion && version.status === 'draft');

  useEffect(() => {
    if (selectedVersion && subscene?.versions.some((item) => item.version === selectedVersion)) return;
    onSelectVersion('');
  }, [selectedSubsceneCode, selectedSceneId, selectedVersion, subscene]);

  const filteredScenes = scenes.filter((item) => matchesQuery(sceneQuery, [item.name, item.description]));
  const filteredSubscenes = scene?.subscenes.filter((item) =>
    matchesQuery(subsceneQuery, [
      item.code,
      item.name,
      latest(item.versions).title,
      latest(item.versions).status,
      latest(item.versions).version,
    ]),
  ) || [];
  const filteredMaterials = materials.filter((item) =>
    matchesQuery(materialQuery, [
      item.id,
      item.skuId,
      item.type,
      item.color,
      item.material,
      item.packageType,
      item.size,
      item.weight,
    ]),
  );

  if (!scene) {
    return (
      <section className="empty-state">
        <p>暂无场景数据，请先在数据文件中维护场景库。</p>
      </section>
    );
  }

  const subsceneColumns: Array<DataTableColumn<Subscene>> = [
    {
      key: 'name',
      title: '任务 SOP',
      width: 'minmax(150px, 1.5fr)',
      render: (item) => latest(item.versions).title || item.name,
    },
    {
      key: 'versions',
      title: '版本数',
      width: '68px',
      align: 'right',
      render: (item) => item.versions.length,
    },
    {
      key: 'latestVersion',
      title: '最新版本',
      width: '78px',
      render: (item) => `v${latest(item.versions).version}`,
    },
    {
      key: 'status',
      title: '状态',
      width: '78px',
      render: (item) => <StatusBadge status={latest(item.versions).status} />,
    },
    {
      key: 'materials',
      title: '物料',
      width: '66px',
      align: 'right',
      render: (item) => `${latest(item.versions).materials.length} 种`,
    },
    {
      key: 'updated',
      title: '最近更新',
      width: '104px',
      render: (item) => formatShortDate(latest(item.versions).updatedAt),
    },
    {
      key: 'action',
      title: '操作',
      width: '54px',
      render: (item) => (
        <button
          className="text-button"
          onClick={(event) => {
            event.stopPropagation();
            openSubsceneDetail(item.code);
          }}
        >
          查看
        </button>
      ),
    },
  ];

  const selectedMaterialColumns: Array<DataTableColumn<SubsceneVersion['materials'][number]>> = [
    {
      key: 'skuId',
      title: 'SKU',
      width: '170px',
      allowOverflow: true,
      render: (item) => {
        const material = materials.find((candidate) => candidate.id === item.materialId);
        const image = material?.images?.[0];
        return (
          <span className="sku-with-image">
            <strong className="table-link">{item.skuId}</strong>
            {image && <AttachmentThumbnail attachment={image} publicBaseUrl={attachmentStorageStatus.publicBaseUrl} />}
          </span>
        );
      },
    },
    { key: 'type', title: '物料类型', width: 'minmax(140px, 1.2fr)', render: (item) => item.type },
    {
      key: 'quantity',
      title: '数量',
      width: '150px',
      render: (item, index) =>
        version && subscene ? (
          <span className="inline-edit">
            <InlineNumberInput
              disabled={!canEditVersion}
              value={item.quantity.value || 0}
              onCommit={(quantityValue) => {
                if (!canEditVersion) return;
                const nextMaterials = version.materials.map((current, currentIndex) =>
                  currentIndex === index
                    ? { ...current, quantity: { ...current.quantity, mode: 'fixed' as const, value: quantityValue } }
                    : current,
                );
                void saveCurrentSubscene({ materials: nextMaterials });
              }}
            />
            {item.quantity.unit}
          </span>
        ) : (
          '-'
        ),
    },
    { key: 'color', title: '颜色', width: '110px', render: (item) => item.color || '-' },
    { key: 'material', title: '材质', width: '120px', render: (item) => item.material || '-' },
    { key: 'packageType', title: '包装类型', width: '120px', render: (item) => item.packageType || '-' },
    {
      key: 'size',
      title: '尺寸',
      width: '120px',
      render: (item) => materials.find((candidate) => candidate.id === item.materialId)?.size || '-',
    },
    {
      key: 'weight',
      title: '重量',
      width: '110px',
      render: (item) => materials.find((candidate) => candidate.id === item.materialId)?.weight || '-',
    },
    {
      key: 'action',
      title: '操作',
      width: '90px',
      render: (item, index) =>
        version && subscene ? (
          <button
            className="text-button danger"
            disabled={!canEditVersion}
            onClick={(event) => {
              event.stopPropagation();
              if (!canEditVersion) return;
              const nextMaterials = version.materials.filter((_, currentIndex) => currentIndex !== index);
              void saveCurrentSubscene({ materials: nextMaterials });
            }}
          >
            移除
          </button>
        ) : (
          '-'
        ),
    },
  ];

  const materialLibraryColumns: Array<DataTableColumn<Material>> = [
    {
      key: 'skuId',
      title: 'SKU 编号',
      width: '130px',
      render: (item) => <strong className="table-link">{item.skuId}</strong>,
    },
    { key: 'type', title: '物料类型', width: 'minmax(140px, 1.2fr)', render: (item) => item.type || '-' },
    { key: 'color', title: '颜色', width: '110px', render: (item) => item.color || '-' },
    { key: 'material', title: '材质', width: '120px', render: (item) => item.material || '-' },
    { key: 'packageType', title: '包装类型', width: '120px', render: (item) => item.packageType || '-' },
    {
      key: 'status',
      title: '引用状态',
      width: '100px',
      render: (item) => (version?.materials.some((material) => material.materialId === item.id) ? '已选择' : '可添加'),
    },
  ];

  function addMaterial(material: Material) {
    if (!version || !subscene || !canEditVersion) return;
    if (version.materials.some((item) => item.materialId === material.id)) return;
    void saveCurrentSubscene({
      materials: [
        ...version.materials,
        {
          materialId: material.id,
          skuId: material.skuId,
          type: material.type,
          quantity: { mode: 'fixed', value: 1, unit: '件' },
          color: material.color,
          material: material.material,
          packageType: material.packageType,
        },
      ],
    });
  }

  async function saveCurrentSubscene(patch: Partial<SubsceneVersion>) {
    if (!subscene || !version) return;
    await onSaveSubscene(scene.id, subscene.code, { ...patch, baseVersion: version.version });
    onSelectVersion('');
  }

  async function createDraftFromCurrentSubsceneVersion() {
    await saveCurrentSubscene({});
  }

  async function deleteCurrentSubsceneDraft() {
    if (!subscene || !version || version.status !== 'draft') return;
    await onDeleteSubsceneVersion(scene.id, subscene.code, version.version);
    onSelectVersion('');
  }

  async function createSubscene() {
    const code = nextSubsceneCode(scenes);
    await onSaveSubscene(scene.id, code, emptySubsceneVersionDraft('新的任务 SOP'));
    onSelectSubscene(code);
    onSelectVersion('');
    onDetailOpenChange(true);
  }

  function selectScene(id: string) {
    onSelectScene(id);
    onDetailOpenChange(false);
    onClearReturnToRequirement();
    setMaterialPickerOpen(false);
  }

  function openSubsceneDetail(code: string) {
    onSelectSubscene(code);
    onSelectVersion('');
    onClearReturnToRequirement();
    onDetailOpenChange(true);
  }

  function closeSubsceneDetail() {
    onDetailOpenChange(false);
    onClearReturnToRequirement();
    setMaterialPickerOpen(false);
  }

  function openSceneEditor() {
    setSceneDraft(emptyScene(`新的场景 ${scenes.length + 1}`));
    setSceneEditorOpen(true);
  }

  function openCurrentSceneEditor() {
    setSceneDraft(scene);
    setSceneEditorOpen(true);
  }

  async function saveSceneDraft() {
    const name = sceneDraft.name.trim();
    if (!name) return;
    await onSaveScene({ ...sceneDraft, name });
    setSceneEditorOpen(false);
  }

  async function uploadSubsceneAttachment(file: File): Promise<RequirementAttachment | undefined> {
    if (!scene || !subscene || !version || !canEditVersion) return undefined;
    if (file.size > 1024 * 1024 * 1024) {
      window.alert('单个附件不能超过 1G');
      return undefined;
    }
    let uploadInit: AttachmentUploadInit | undefined;
    try {
      setAttachmentUpload({ fileName: file.name, progress: 0 });
      uploadInit = await api.initSubsceneAttachmentUpload(scene.id, subscene.code, version.version, file);
      const parts: AttachmentUploadPart[] = [];
      const totalParts = Math.ceil(file.size / uploadInit.partSize);
      for (let index = 0; index < totalParts; index += 1) {
        const start = index * uploadInit.partSize;
        const end = Math.min(file.size, start + uploadInit.partSize);
        const part = await api.uploadSubsceneAttachmentPart(
          scene.id,
          subscene.code,
          version.version,
          uploadInit.uploadId,
          uploadInit.storageKey,
          index + 1,
          file.slice(start, end, file.type || 'application/octet-stream'),
        );
        parts.push({ partNumber: index + 1, etag: part.etag });
        setAttachmentUpload({ fileName: file.name, progress: Math.round(((index + 1) / totalParts) * 100) });
      }
      const attachment = await api.completeSubsceneAttachmentUpload(
        scene.id,
        subscene.code,
        version.version,
        uploadInit.attachmentId,
        uploadInit.uploadId,
        uploadInit.storageKey,
        parts,
      );
      const nextData = await api.data();
      onScenesChange(nextData.scenes);
      return attachment;
    } catch (error) {
      if (uploadInit) {
        await api.abortSubsceneAttachmentUpload(
          scene.id,
          subscene.code,
          version.version,
          uploadInit.attachmentId,
          uploadInit.uploadId,
          uploadInit.storageKey,
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      setAttachmentUpload(null);
    }
  }

  const robotStateOptions = fieldOptions(globalFields, 'robot_state', [version?.robotState.initial || '', version?.robotState.target || '']).map((option) => ({
    value: option.value,
    label: option.label,
  }));
  const robotRandomFields = version?.randomization.robotInitialState.randomizedFields.map((item) => item.field) || [];
  const robotRandomOptions = uniqueOptions([
    ...fieldOptions(globalFields, 'robot_random_field', robotRandomFields),
    ...fallbackRobotRandomOptions,
  ]);
  const robotInitialRandomRows = version ? robotInitialRandomizationRows(version.randomization, version.randomizationFrequency) : [];
  function saveRobotInitialRandomRows(nextRows: RobotInitialRandomizationRow[]) {
    if (!version) return;
    void saveCurrentSubscene(robotInitialRandomizationPatch(version, nextRows));
  }
  const robotInitialRandomColumns: Array<DataTableColumn<RobotInitialRandomizationRow>> = [
    {
      key: 'target',
      title: '对象',
      width: '160px',
      render: (row) => row.target,
    },
    {
      key: 'frequency',
      title: '每多少条变换',
      width: '140px',
      render: (row, index) => (
        <input
          type="number"
          min={1}
          value={row.changeIntervalRecords || 1}
          disabled={!canEditVersion}
          onChange={(event) => {
            const nextRows = robotInitialRandomRows.map((current, currentIndex) =>
              currentIndex === index ? { ...current, changeIntervalRecords: Number(event.target.value) || 1 } : current,
            );
            saveRobotInitialRandomRows(nextRows);
          }}
        />
      ),
    },
    {
      key: 'fields',
      title: '随机性要求',
      width: 'minmax(260px, 1.2fr)',
      allowOverflow: true,
      render: (row, index) => (
        <MultiSelectInput
          value={row.randomizedFields}
          options={uniqueOptions([
            ...robotRandomOptions,
            ...row.randomizedFields
              .filter((field) => !robotRandomOptions.some((option) => option.value === field))
              .map((field) => ({ value: field, label: field })),
          ])}
          disabled={!canEditVersion}
          onChange={(randomizedFields) => {
            const nextRows = robotInitialRandomRows.map((current, currentIndex) =>
              currentIndex === index ? { ...current, randomizedFields } : current,
            );
            saveRobotInitialRandomRows(nextRows);
          }}
        />
      ),
    },
    {
      key: 'constraints',
      title: '限制条件',
      width: 'minmax(260px, 1fr)',
      render: (row, index) => (
        <LongTextDialogEditor
          title="机器人初始态随机性限制条件"
          value={row.constraints}
          disabled={!canEditVersion}
          placeholder="限制条件"
          onChange={(constraints) => {
            const nextRows = robotInitialRandomRows.map((current, currentIndex) =>
              currentIndex === index ? { ...current, constraints } : current,
            );
            saveRobotInitialRandomRows(nextRows);
          }}
        />
      ),
    },
    {
      key: 'action',
      title: '操作',
      width: '86px',
      render: (_row, index) => (
        <button
          className="text-button danger"
          disabled={!canEditVersion}
          onClick={() => {
            const nextRows = robotInitialRandomRows.filter((_, currentIndex) => currentIndex !== index);
            saveRobotInitialRandomRows(nextRows);
          }}
        >
          移除
        </button>
      ),
    },
  ];

  const materialPickerModal = materialPickerOpen && (
    <Modal title="从物料库添加物料" onClose={() => setMaterialPickerOpen(false)}>
      <SearchPanel
        title="物料库"
        description="点击物料行添加到当前任务 SOP"
        query={materialQuery}
        placeholder="搜索 SKU、物料类型、颜色、材质"
        count={filteredMaterials.length}
        onQueryChange={setMaterialQuery}
      />
      <DataTable
        rows={filteredMaterials}
        columns={materialLibraryColumns}
        rowKey={(material) => material.id}
        emptyText="没有匹配的物料"
        onRowClick={addMaterial}
      />
    </Modal>
  );

  if (detailOpen && subscene && version) {
    return (
      <>
        <div className="detail-page">
          <div className="detail-page-toolbar">
            <div className="button-row">
              {returnToRequirement && (
                <button className="ghost-button" onClick={onReturnToRequirement}>
                  返回需求页
                </button>
              )}
              <button className="ghost-button" onClick={closeSubsceneDetail}>
                返回任务 SOP 列表
              </button>
            </div>
            <span>{scene.name} / v{version.version}</span>
          </div>
          <section className="panel detail-panel">
            <div className="panel-header">
              <div>
                <h2>{version.title || subscene.name}</h2>
                <p>
                  v{version.version} · {statusText(version.status)}
                </p>
              </div>
              <div className="button-row">
                <label className="version-select">
                  <span>版本</span>
                  <select value={version.version} onChange={(event) => onSelectVersion(event.target.value)}>
                    {subscene.versions.map((item) => (
                      <option value={item.version} key={item.version}>
                        v{item.version} · {statusText(item.status)}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="ghost-button" onClick={() => exportReportAsPdf(buildSubscenePdfReport(scene, subscene, version, attachmentStorageStatus.publicBaseUrl))}>
                  导出 PDF
                </button>
                {version.status === 'confirmed' ? (
                  <button className="primary-button" onClick={() => void createDraftFromCurrentSubsceneVersion()}>
                    编辑为草稿
                  </button>
                ) : (
                  <>
                    <button className="ghost-button danger" onClick={() => void deleteCurrentSubsceneDraft()}>
                      删除草稿
                    </button>
                    <button className="primary-button" onClick={() => void onConfirmSubscene(scene.id, subscene.code, version.version)}>
                      确认任务 SOP
                    </button>
                  </>
                )}
              </div>
            </div>
            {version.status === 'confirmed' && <div className="notice info">当前任务 SOP 已确认，点击“编辑为草稿”会复制出新的草稿版本。</div>}
            <CollapsibleSection title="基础信息" description="0.0.1 草稿可编辑名称；草稿版本可编辑描述">
              <div className="form-grid compact-fields">
                <Field
                  label="任务 SOP 名称"
                  value={version.title || ''}
                  disabled={!canEditSubsceneTitle}
                  onChange={(title) => void saveCurrentSubscene({ title })}
                />
              </div>
              <TextArea
                label="任务 SOP 描述"
                value={version.description || ''}
                disabled={!canEditDescription}
                onChange={(description) => void saveCurrentSubscene({ description })}
              />
              <AttachmentField
                title="任务 SOP 附件"
                hint="支持上传图片或视频，单个附件不超过 1G"
                accept="image/*,video/*"
                attachments={version.attachments || []}
                disabled={!canEditVersion}
                storageStatus={attachmentStorageStatus}
                upload={attachmentUpload}
                onUpload={(file) => onRun(() => uploadSubsceneAttachment(file), '任务 SOP 附件已上传').then(() => undefined)}
                onDownload={(attachment) => onRun(() => downloadStoredAttachment(attachment), '附件已下载').then(() => undefined)}
                onDelete={async (attachmentId) => {
                  if (!scene || !subscene || !version) return;
                  const result = await onRun(
                    () => api.deleteSubsceneAttachment(scene.id, subscene.code, version.version, attachmentId),
                    '任务 SOP 附件已删除',
                  );
                  if (result) onScenesChange(result);
                }}
              />
            </CollapsibleSection>
            <CollapsibleSection title="机器人与随机性" description="机器人初始态、目标态和初始状态随机性">
              <div className="form-grid compact-fields">
                <SelectFieldInline
                  label="机器人初始态"
                  value={version.robotState.initial}
                  options={robotStateOptions}
                  disabled={!canEditVersion}
                  onChange={(initial) => void saveCurrentSubscene({ robotState: { ...version.robotState, initial } })}
                />
                <SelectFieldInline
                  label="机器人目标态"
                  value={version.robotState.target}
                  options={robotStateOptions}
                  disabled={!canEditVersion}
                  onChange={(target) => void saveCurrentSubscene({ robotState: { ...version.robotState, target } })}
                />
              </div>
              <div className="embedded-table robot-randomization-table">
                <div className="embedded-table-header">
                  <div>
                    <h3>机器人初始态随机性</h3>
                    <p>按机器人初始状态配置随机字段与变换频率</p>
                  </div>
                  <button
                    className="primary-button"
                    disabled={!canEditVersion || robotInitialRandomRows.length > 0}
                    onClick={() =>
                      saveRobotInitialRandomRows([
                        {
                          target: '机器人初始态',
                          changeIntervalRecords: 1,
                          randomizedFields: [],
                          constraints: '',
                        },
                      ])
                    }
                  >
                    添加随机性
                  </button>
                </div>
                <DataTable
                  rows={robotInitialRandomRows}
                  columns={robotInitialRandomColumns}
                  rowKey={(_row, index) => `robot-initial-random-${index}`}
                  emptyText="暂无机器人初始态随机性"
                />
              </div>
            </CollapsibleSection>
            <CollapsibleSection title="物料相关" description="选择本任务 SOP 物料，并维护物料状态、状态规则和随机性要求">
              <div className="embedded-table">
                <div className="embedded-table-header">
                  <div>
                    <h3>已选物料</h3>
                    <p>点击添加从物料库选择，已选物料支持移除</p>
                  </div>
                  <div className="button-row">
                    <span className="result-count">{version.materials.length} 条</span>
                    <button className="primary-button" disabled={!canEditVersion} onClick={() => setMaterialPickerOpen(true)}>
                      添加物料
                    </button>
                  </div>
                </div>
                <DataTable
                  rows={version.materials}
                  columns={selectedMaterialColumns}
                  rowKey={(material, index) => `${material.skuId}-${index}`}
                  emptyText="当前任务 SOP 还没有选择物料"
                />
              </div>
              <SubsceneStateEditor
                globalFields={globalFields}
                version={version}
                materials={version.materials}
                readOnly={!canEditVersion}
                storageStatus={attachmentStorageStatus}
                upload={attachmentUpload}
                onUploadImage={(file) => onRun(() => uploadSubsceneAttachment(file), '示例图片已上传')}
                onSave={(patch) => {
                  if (!canEditVersion) return;
                  void saveCurrentSubscene(patch);
                }}
              />
            </CollapsibleSection>
            <CollapsibleSection title="采集步骤和说明" description="仅当前任务 SOP 使用的采集步骤、采集操作要求与禁止操作">
              <StepsTable
                title="采集步骤"
                description="左侧填写中文步骤和原子技能，右侧填写对应英文"
                emptyText="暂无采集步骤"
                steps={version.operation.steps}
                disabled={!canEditVersion}
                enableBulkImport
                onChange={(steps) => void saveCurrentSubscene({ operation: { ...version.operation, steps } })}
              />
              <StepRandomizationEditor
                title="采集步骤随机性"
                value={version.operation.stepRandomization}
                disabled={!canEditVersion}
                onChange={(stepRandomization) => void saveCurrentSubscene({ operation: { ...version.operation, stepRandomization } })}
              />
              <LocalTextItemEditor
                title="采集操作要求"
                description="仅在当前任务 SOP 中生效，可直接新建"
                items={version.operation.allowedOperations}
                disabled={!canEditVersion}
                onChange={(allowedOperations) => void saveCurrentSubscene({ operation: { ...version.operation, allowedOperations } })}
              />
              <LocalTextItemEditor
                title="采集禁止操作"
                description="仅在当前任务 SOP 中生效，可直接新建"
                items={version.operation.forbiddenOperations}
                disabled={!canEditVersion}
                onChange={(forbiddenOperations) => void saveCurrentSubscene({ operation: { ...version.operation, forbiddenOperations } })}
              />
              <LocalTextItemEditor
                title="不完美但可接受的采集操作"
                description="仅在当前任务 SOP 中生效，可直接新建"
                items={version.operation.acceptableOperations || []}
                disabled={!canEditVersion}
                onChange={(acceptableOperations) => void saveCurrentSubscene({ operation: { ...version.operation, acceptableOperations } })}
              />
            </CollapsibleSection>
            <CollapsibleSection title="标注步骤和说明" description="标注步骤，以及仅当前任务 SOP 生效的标注操作要求与禁止操作">
              <StepsTable
                title="标注步骤"
                description="左侧填写中文步骤和原子技能，右侧填写对应英文"
                emptyText="暂无标注步骤"
                steps={version.annotation.steps || []}
                disabled={!canEditVersion}
                onChange={(steps) => void saveCurrentSubscene({ annotation: { ...version.annotation, steps } })}
              />
              <LocalTextItemEditor
                title="标注操作要求"
                description="仅在当前任务 SOP 中生效，可直接新建"
                items={version.annotation.allowedOperations || []}
                disabled={!canEditVersion}
                onChange={(allowedOperations) => void saveCurrentSubscene({ annotation: { ...version.annotation, allowedOperations } })}
              />
              <LocalTextItemEditor
                title="标注禁止操作"
                description="仅在当前任务 SOP 中生效，可直接新建"
                items={version.annotation.forbiddenOperations || []}
                disabled={!canEditVersion}
                onChange={(forbiddenOperations) => void saveCurrentSubscene({ annotation: { ...version.annotation, forbiddenOperations } })}
              />
            </CollapsibleSection>
          </section>
        </div>
        {materialPickerModal}
      </>
    );
  }

  return (
    <div className="scene-workbench">
      <aside className="scene-directory panel">
        <SearchPanel
          title="场景目录"
          description="按场景分组展示任务 SOP"
          query={sceneQuery}
          placeholder="搜索场景名称或描述"
          count={filteredScenes.length}
          onQueryChange={setSceneQuery}
          actions={
            <button className="primary-button" onClick={openSceneEditor}>
              新建场景
            </button>
          }
        />
        <div className="directory-list">
          {filteredScenes.map((item) => (
            <div className={`directory-group ${item.id === scene.id ? 'selected' : ''}`} key={item.id}>
              <button
                className="directory-row scene-row"
                onClick={() => selectScene(item.id)}
              >
                <strong>{item.name}</strong>
                <span>{item.subscenes.length} 个任务 SOP</span>
              </button>
              {item.id === scene.id && (
                <div className="directory-children">
                  {item.subscenes.map((child) => (
                    <button
                      className="directory-row subscene-row"
                      key={child.code}
                      onClick={() => openSubsceneDetail(child.code)}
                    >
                      <strong>{latest(child.versions).title || child.name}</strong>
                      <span>v{latest(child.versions).version} · {statusText(latest(child.versions).status)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

      <section className="scene-main">
        <section className="panel scene-summary">
          <div className="panel-header">
            <div>
              <h2>{scene.name}</h2>
              <p>{scene.description || '暂无场景描述'}</p>
            </div>
            <button className="ghost-button" onClick={openCurrentSceneEditor}>
              编辑场景
            </button>
          </div>
          <div className="info-grid">
            <InfoItem label="任务 SOP 数" value={scene.subscenes.length} />
            <InfoItem label="最近更新" value={sceneLatestUpdated(scene)} />
          </div>
        </section>

        <section className="panel table-panel">
          <SearchPanel
            title="任务 SOP 列表"
            description="点击任务 SOP 进入详情页"
            query={subsceneQuery}
            placeholder="搜索名称、状态或版本"
            count={filteredSubscenes.length}
            onQueryChange={setSubsceneQuery}
            actions={<button className="primary-button" onClick={() => void createSubscene()}>新建任务 SOP</button>}
          />
          <DataTable
            rows={filteredSubscenes}
            columns={subsceneColumns}
            rowKey={(item) => item.code}
            emptyText="没有匹配的任务 SOP"
            onRowClick={(item) => openSubsceneDetail(item.code)}
          />
        </section>
      </section>
      {materialPickerModal}
      {sceneEditorOpen && (
        <Modal title={sceneDraft.id ? '编辑场景' : '新建场景'} onClose={() => setSceneEditorOpen(false)}>
          <div className="modal-body">
            <div className="form-grid">
              <Field label="场景名称" value={sceneDraft.name} onChange={(name) => setSceneDraft({ ...sceneDraft, name })} />
            </div>
            <TextArea
              label="场景描述"
              value={sceneDraft.description}
              onChange={(description) => setSceneDraft({ ...sceneDraft, description })}
            />
            <div className="form-actions">
              <button className="primary-button" disabled={!sceneDraft.name.trim()} onClick={() => void saveSceneDraft()}>
                保存场景
              </button>
              <button className="ghost-button" onClick={() => setSceneEditorOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function GlobalFieldPage({
  globalFields,
  onSaveField,
}: {
  globalFields: GlobalField[];
  onSaveField: (field: GlobalField) => Promise<void>;
}) {
  const [fieldQuery, setFieldQuery] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<GlobalFieldGroup>('reference_object');
  const [statusFilter, setStatusFilter] = useState<GlobalFieldStatus | 'all'>('all');
  const [fieldDraft, setFieldDraft] = useState<GlobalField>(emptyGlobalField('reference_object'));
  const [editorOpen, setEditorOpen] = useState(false);
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(globalFieldCategories.map((category) => [category.id, category.groups.includes('reference_object')])),
  );

  const filteredFields = globalFields.filter(
    (field) =>
      field.group === selectedGroup &&
      (statusFilter === 'all' || field.status === statusFilter) &&
      matchesQuery(fieldQuery, [
        field.id,
        field.label,
        field.value,
        field.description,
        field.status === 'active' ? '启用' : '停用',
      ]),
  );

  const fieldColumns: Array<DataTableColumn<GlobalField>> = [
    {
      key: 'label',
      title: '字段名称',
      width: 'minmax(180px, 1.4fr)',
      render: (item) => <strong className="table-link">{item.label}</strong>,
    },
    {
      key: 'status',
      title: '状态',
      width: '92px',
      render: (item) => <StatusBadge status={item.status} />,
    },
    { key: 'updatedAt', title: '更新时间', width: '118px', render: (item) => formatShortDate(item.updatedAt) },
  ];
  const groupOptions = globalFieldCategories.flatMap((category) =>
    category.groups.map((group) => ({ value: group, label: `${category.label} / ${globalFieldGroupLabels[group]}` })),
  );

  function countFieldsInGroup(group: GlobalFieldGroup) {
    return globalFields.filter((field) => field.group === group).length;
  }

  function countFieldsInCategory(category: GlobalFieldCategory) {
    return category.groups.reduce((total, group) => total + countFieldsInGroup(group), 0);
  }

  function toggleCategory(categoryId: string) {
    setOpenCategories((current) => ({ ...current, [categoryId]: !current[categoryId] }));
  }

  function saveFieldDraft(patch: Partial<GlobalField> = {}): boolean {
    const label = (patch.label ?? fieldDraft.label).trim();
    const next = {
      ...fieldDraft,
      group: fieldDraft.group || selectedGroup,
      ...patch,
      label,
      value: label,
    };
    if (!next.label) return false;
    void onSaveField(next);
    setFieldDraft(emptyGlobalField(next.group));
    return true;
  }

  function selectGroup(group: GlobalFieldGroup) {
    const category = findGlobalFieldCategory(group);
    if (category) {
      setOpenCategories((current) => ({ ...current, [category.id]: true }));
    }
    setSelectedGroup(group);
    setFieldDraft(emptyGlobalField(group));
    setEditorOpen(false);
  }

  function openFieldEditor(field: GlobalField) {
    setFieldDraft(field);
    setEditorOpen(true);
  }

  function openNewFieldEditor() {
    setFieldDraft(emptyGlobalField(selectedGroup));
    setEditorOpen(true);
  }

  function saveFieldAndClose(patch: Partial<GlobalField> = {}) {
    if (saveFieldDraft(patch)) {
      setEditorOpen(false);
    }
  }

  return (
    <div className="global-field-workbench">
      <aside className="field-groups panel">
        <div className="panel-header">
          <div>
            <h2>字段分组</h2>
            <p>全局词表分组</p>
          </div>
        </div>
        <div className="field-group-list">
          {globalFieldCategories.map((category) => {
            const isOpen = openCategories[category.id] ?? false;
            const selectedInCategory = category.groups.includes(selectedGroup);
            const total = countFieldsInCategory(category);
            return (
              <div className={`field-category ${selectedInCategory ? 'contains-selected' : ''}`} key={category.id}>
                <button
                  type="button"
                  className="field-category-row"
                  aria-expanded={isOpen}
                  onClick={() => toggleCategory(category.id)}
                >
                  <span>
                    <strong>{category.label}</strong>
                    <small>{category.description}</small>
                  </span>
                  <span className="field-category-meta">
                    <span>{total}</span>
                    <b>{isOpen ? '收起' : '展开'}</b>
                  </span>
                </button>
                {isOpen && (
                  <div className="field-category-groups">
                    {category.groups.map((group) => (
                      <button
                        type="button"
                        className={`field-group-row ${selectedGroup === group ? 'selected' : ''}`}
                        key={group}
                        onClick={() => selectGroup(group)}
                      >
                        <strong>{globalFieldGroupLabels[group]}</strong>
                        <span>{countFieldsInGroup(group)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <section className="panel table-panel global-field-values">
        <SearchPanel
          title={`${globalFieldGroupLabels[selectedGroup]}字段`}
          description="停用后不再出现在新的下拉选择中，历史数据仍保留"
          query={fieldQuery}
          placeholder="搜索字段名称或说明"
          count={filteredFields.length}
          onQueryChange={setFieldQuery}
          actions={
            <>
              <label className="compact-filter">
                <span>状态</span>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as GlobalFieldStatus | 'all')}>
                  <option value="all">全部</option>
                  <option value="active">启用</option>
                  <option value="inactive">停用</option>
                </select>
              </label>
              <button className="primary-button" onClick={openNewFieldEditor}>
                新建字段
              </button>
            </>
          }
        />
        <DataTable
          rows={filteredFields}
          columns={fieldColumns}
          rowKey={(item) => item.id}
          selectedKey={fieldDraft.id}
          emptyText="当前分组没有匹配字段"
          onRowClick={openFieldEditor}
        />
      </section>
      {editorOpen && (
        <Modal title="字段详情" onClose={() => setEditorOpen(false)}>
          <div className="modal-body">
            <div className="form-grid">
              <SelectField
                label="字段分组"
                value={fieldDraft.group}
                options={groupOptions}
                onChange={(group) => {
                  const nextGroup = group as GlobalFieldGroup;
                  selectGroup(nextGroup);
                  setFieldDraft({ ...fieldDraft, group: nextGroup });
                  setEditorOpen(true);
                }}
              />
              <SelectField
                label="状态"
                value={fieldDraft.status}
                options={[
                  { value: 'active', label: '启用' },
                  { value: 'inactive', label: '停用' },
                ]}
                onChange={(status) => setFieldDraft({ ...fieldDraft, status: status as GlobalFieldStatus })}
              />
              <Field label="字段名称" value={fieldDraft.label} onChange={(label) => setFieldDraft({ ...fieldDraft, label })} />
              <Field
                label="说明"
                value={fieldDraft.description || ''}
                onChange={(description) => setFieldDraft({ ...fieldDraft, description })}
              />
            </div>
            <div className="form-actions">
              <button className="primary-button" onClick={() => saveFieldAndClose()}>
                保存字段
              </button>
              {fieldDraft.id && (
                <button
                  className="ghost-button"
                  onClick={() => saveFieldAndClose({ status: fieldDraft.status === 'active' ? 'inactive' : 'active' })}
                >
                  {fieldDraft.status === 'active' ? '停用字段' : '启用字段'}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function MultiSelectField({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string[];
  options: Option[];
  disabled?: boolean;
  onChange: (value: string[]) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <MultiSelectInput value={value} options={options} disabled={disabled} onChange={onChange} />
    </label>
  );
}

function OperationRequirementGroup({
  title,
  value,
  options,
  readOnly,
  onChange,
}: {
  title: string;
  value: string[];
  options: Option[];
  readOnly: boolean;
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(!readOnly);
  const selectedOptions = value.map((item) => options.find((option) => option.value === item) || { value: item, label: item });
  const allOptions = uniqueOptions([...options, ...selectedOptions]);
  const visibleOptions = readOnly ? selectedOptions : allOptions;
  const summary = selectedOptions.length ? selectedOptions.map((option) => option.label).join('、') : '未选择';

  useEffect(() => {
    setOpen(!readOnly);
  }, [readOnly]);

  function toggleValue(target: string) {
    if (readOnly) return;
    if (value.includes(target)) {
      onChange(value.filter((item) => item !== target));
      return;
    }
    onChange([...value, target]);
  }

  function optionDescription(option: Option): string {
    const description = option.description?.trim() || '';
    return description && description !== option.label ? description : '';
  }

  return (
    <div className={`operation-requirement-group ${open ? 'open' : ''}`}>
      <button type="button" className="operation-requirement-summary" onClick={() => setOpen((current) => !current)}>
        <span>
          <strong>{title}</strong>
          <small>{readOnly ? summary : `${selectedOptions.length} / ${allOptions.length} 已选`}</small>
        </span>
        <b>{open ? '收起' : '展开'}</b>
      </button>
      {open && (
        <div className="operation-requirement-content">
          {visibleOptions.length === 0 ? (
            <div className="operation-requirement-empty">{readOnly ? '暂无已选条目' : '暂无可选条目'}</div>
          ) : (
            visibleOptions.map((option) =>
              readOnly ? (
                <div className="operation-requirement-readonly-item" key={`${title}-${option.value}`}>
                  <span>{option.category ? `${option.category} / ${option.label}` : option.label}</span>
                  {optionDescription(option) && <small>{optionDescription(option)}</small>}
                </div>
              ) : (
                <label className="operation-requirement-option" key={`${title}-${option.value}`}>
                  <input type="checkbox" checked={value.includes(option.value)} onChange={() => toggleValue(option.value)} />
                  <span>
                    {option.category ? `${option.category} / ${option.label}` : option.label}
                    {optionDescription(option) && <small>{optionDescription(option)}</small>}
                  </span>
                </label>
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({
  title,
  description,
  defaultOpen = true,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="collapsible-section" open={defaultOpen}>
      <summary>
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        <span>展开/收起</span>
      </summary>
      <div className="collapsible-content">{children}</div>
    </details>
  );
}

function SelectFieldInline({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">请选择</option>
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberedTextArea({
  value,
  disabled,
  placeholder,
  minRows = 1,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  placeholder?: string;
  minRows?: number;
  onChange: (value: string) => void;
}) {
  const lineCount = Math.max(minRows, value.split('\n').length || 1);

  return (
    <div className="numbered-textarea">
      <div className="line-number-gutter" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      <textarea
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function splitStepBulkLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').split('\n');
}

function BulkStepsModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (steps: OperationStep[]) => void;
}) {
  const [draft, setDraft] = useState({
    description: '',
    atomicSkill: '',
    englishDescription: '',
    englishAtomicSkill: '',
  });
  const columns = {
    description: splitStepBulkLines(draft.description),
    atomicSkill: splitStepBulkLines(draft.atomicSkill),
    englishDescription: splitStepBulkLines(draft.englishDescription),
    englishAtomicSkill: splitStepBulkLines(draft.englishAtomicSkill),
  };
  const maxRows = Math.max(
    columns.description.length,
    columns.atomicSkill.length,
    columns.englishDescription.length,
    columns.englishAtomicSkill.length,
  );
  const importedSteps = Array.from({ length: maxRows }, (_, index) => ({
    order: index + 1,
    description: columns.description[index]?.trim() || '',
    atomicSkill: columns.atomicSkill[index]?.trim() || '',
    englishDescription: columns.englishDescription[index]?.trim() || '',
    englishAtomicSkill: columns.englishAtomicSkill[index]?.trim() || '',
  })).filter((step) => step.description || step.atomicSkill || step.englishDescription || step.englishAtomicSkill);

  return (
    <Modal title="批量输入步骤" panelClassName="step-bulk-panel" onClose={onClose}>
      <div className="modal-body step-bulk-modal">
        <p className="helper-text">每一行会按行号合并成同一个步骤；可以只填写其中几列。</p>
        <div className="step-bulk-grid">
          <label>
            <span>中文步骤</span>
            <NumberedTextArea
              value={draft.description}
              minRows={8}
              placeholder="一行一个中文步骤"
              onChange={(description) => setDraft((current) => ({ ...current, description }))}
            />
          </label>
          <label>
            <span>中文原子技能</span>
            <NumberedTextArea
              value={draft.atomicSkill}
              minRows={8}
              placeholder="一行一个原子技能"
              onChange={(atomicSkill) => setDraft((current) => ({ ...current, atomicSkill }))}
            />
          </label>
          <label>
            <span>English Step</span>
            <NumberedTextArea
              value={draft.englishDescription}
              minRows={8}
              placeholder="One English step per line"
              onChange={(englishDescription) => setDraft((current) => ({ ...current, englishDescription }))}
            />
          </label>
          <label>
            <span>English Atomic Skill</span>
            <NumberedTextArea
              value={draft.englishAtomicSkill}
              minRows={8}
              placeholder="One atomic skill per line"
              onChange={(englishAtomicSkill) => setDraft((current) => ({ ...current, englishAtomicSkill }))}
            />
          </label>
        </div>
        <div className="form-actions">
          <button className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={importedSteps.length === 0} onClick={() => onConfirm(importedSteps)}>
            确认导入
          </button>
        </div>
      </div>
    </Modal>
  );
}

function StepsTable({
  title,
  description,
  emptyText,
  steps,
  disabled,
  enableBulkImport = false,
  onChange,
}: {
  title: string;
  description: string;
  emptyText: string;
  steps: OperationStep[];
  disabled: boolean;
  enableBulkImport?: boolean;
  onChange: (steps: OperationStep[]) => void;
}) {
  const stepsSignature = JSON.stringify(steps);
  const [draftSteps, setDraftSteps] = useState<OperationStep[]>(() => normalize(steps));
  const [bulkOpen, setBulkOpen] = useState(false);

  useEffect(() => {
    setDraftSteps(normalize(steps));
  }, [stepsSignature]);

  function normalize(nextSteps: OperationStep[]) {
    return nextSteps.map((step, index) => ({ ...step, order: index + 1 }));
  }

  function commitSteps(nextSteps = draftSteps) {
    const normalizedSteps = normalize(nextSteps);
    if (JSON.stringify(normalizedSteps) !== JSON.stringify(normalize(steps))) {
      onChange(normalizedSteps);
    }
  }

  function updateStepDraft(index: number, patch: Partial<OperationStep>) {
    setDraftSteps((currentSteps) =>
      normalize(
        currentSteps.map((step, currentIndex) =>
          currentIndex === index
            ? {
                ...step,
                ...patch,
              }
            : step,
        ),
      ),
    );
  }

  function addStep() {
    setDraftSteps((currentSteps) =>
      normalize([
        ...currentSteps,
        { order: currentSteps.length + 1, description: '', atomicSkill: '', englishDescription: '', englishAtomicSkill: '' },
      ]),
    );
  }

  function removeStep(index: number) {
    const nextSteps = normalize(draftSteps.filter((_, currentIndex) => currentIndex !== index));
    setDraftSteps(nextSteps);
    onChange(nextSteps);
  }

  function importSteps(importedSteps: OperationStep[]) {
    const nextSteps = normalize([...draftSteps, ...importedSteps]);
    setDraftSteps(nextSteps);
    onChange(nextSteps);
    setBulkOpen(false);
  }

  return (
    <>
      <div className="embedded-table annotation-steps-table">
        <div className="embedded-table-header">
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
          <div className="button-row">
            {enableBulkImport && (
              <button className="ghost-button" disabled={disabled} onClick={() => setBulkOpen(true)}>
                批量输入步骤
              </button>
            )}
            <button className="primary-button" disabled={disabled} onClick={addStep}>
              新增步骤
            </button>
          </div>
        </div>
        <div className="annotation-steps-grid">
          <div className="annotation-steps-head">序号</div>
          <div className="annotation-steps-head">中文步骤</div>
          <div className="annotation-steps-head">中文原子技能</div>
          <div className="annotation-steps-head">English Step</div>
          <div className="annotation-steps-head">English Atomic Skill</div>
          <div className="annotation-steps-head">操作</div>
          {draftSteps.length === 0 ? (
            <div className="annotation-steps-empty">{emptyText}</div>
          ) : (
            draftSteps.map((step, index) => (
              <div className="annotation-steps-row" key={`${title}-${index}`}>
                <div className="annotation-step-order">{index + 1}</div>
                <textarea
                  value={step.description || ''}
                  disabled={disabled}
                  placeholder="中文步骤"
                  onBlur={() => commitSteps()}
                  onChange={(event) => updateStepDraft(index, { description: event.target.value })}
                />
                <textarea
                  value={step.atomicSkill || ''}
                  disabled={disabled}
                  placeholder="中文原子技能"
                  onBlur={() => commitSteps()}
                  onChange={(event) => updateStepDraft(index, { atomicSkill: event.target.value })}
                />
                <textarea
                  value={step.englishDescription || ''}
                  disabled={disabled}
                  placeholder="English step"
                  onBlur={() => commitSteps()}
                  onChange={(event) => updateStepDraft(index, { englishDescription: event.target.value })}
                />
                <textarea
                  value={step.englishAtomicSkill || ''}
                  disabled={disabled}
                  placeholder="English atomic skill"
                  onBlur={() => commitSteps()}
                  onChange={(event) => updateStepDraft(index, { englishAtomicSkill: event.target.value })}
                />
                <button className="text-button danger" disabled={disabled} onClick={() => removeStep(index)}>
                  移除
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      {bulkOpen && <BulkStepsModal onClose={() => setBulkOpen(false)} onConfirm={importSteps} />}
    </>
  );
}

function StepRandomizationEditor({
  title,
  value,
  disabled,
  onChange,
}: {
  title: string;
  value?: { enabled: boolean; startOrder: number; endOrder: number };
  disabled: boolean;
  onChange: (value: { enabled: boolean; startOrder: number; endOrder: number }) => void;
}) {
  const current = value || { enabled: false, startOrder: 1, endOrder: 1 };
  return (
    <div className="form-grid compact-fields">
      <label className="field checkbox-field">
        <span>{title}</span>
        <label>
          <input
            type="checkbox"
            checked={current.enabled}
            disabled={disabled}
            onChange={(event) => onChange({ ...current, enabled: event.target.checked })}
          />
          启用
        </label>
      </label>
      <label className="field">
        <span>第几步到第几步可随机</span>
        <span className="range-edit">
          <input
            type="number"
            min={1}
            value={current.startOrder}
            disabled={disabled}
            onChange={(event) => onChange({ ...current, startOrder: Number(event.target.value) || 1 })}
          />
          <input
            type="number"
            min={1}
            value={current.endOrder}
            disabled={disabled}
            onChange={(event) => onChange({ ...current, endOrder: Number(event.target.value) || 1 })}
          />
        </span>
      </label>
    </div>
  );
}

function LongTextDialogEditor({
  title,
  value,
  disabled,
  placeholder = '填写内容',
  onChange,
}: {
  title: string;
  value: string;
  disabled: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!open) setDraft(value);
  }, [open, value]);

  function save() {
    onChange(draft);
    setOpen(false);
  }

  return (
    <>
      <button type="button" className="summary-edit-button" disabled={disabled} onClick={() => setOpen(true)}>
        <span>{value || placeholder}</span>
      </button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          <div className="modal-body">
            <textarea
              className="long-text-editor"
              value={draft}
              placeholder={placeholder}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="form-actions">
              <button className="primary-button" onClick={save}>
                保存
              </button>
              <button className="ghost-button" onClick={() => setOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function LocalTextItemEditor({
  title,
  description,
  items,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  items: SubsceneVersion['operation']['allowedOperations'];
  disabled: boolean;
  onChange: (items: SubsceneVersion['operation']['allowedOperations']) => void;
}) {
  const itemsSignature = JSON.stringify(items);
  const [draftItems, setDraftItems] = useState<TextItem[]>(items);

  useEffect(() => {
    setDraftItems(items);
  }, [itemsSignature]);

  function commitItems(nextItems = draftItems) {
    if (JSON.stringify(nextItems) !== JSON.stringify(items)) {
      onChange(nextItems);
    }
  }

  function updateItemDraft(index: number, description: string) {
    setDraftItems((currentItems) =>
      currentItems.map((current, currentIndex) => (currentIndex === index ? { ...current, description } : current)),
    );
  }

  function addItem() {
    setDraftItems((currentItems) => [...currentItems, { description: '' }]);
  }

  function removeItem(index: number) {
    const nextItems = draftItems.filter((_, currentIndex) => currentIndex !== index);
    setDraftItems(nextItems);
    onChange(nextItems);
  }

  return (
    <div className="embedded-table">
      <div className="embedded-table-header">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <button
          className="primary-button"
          disabled={disabled}
          onClick={addItem}
        >
          新增
        </button>
      </div>
      <div className="local-item-list">
        {draftItems.length === 0 && <div className="table-empty">暂无内容</div>}
        {draftItems.map((item, index) => (
          <div className="local-item-row" key={`${title}-${index}`}>
            <input
              value={item.description}
              disabled={disabled}
              placeholder="说明"
              onBlur={() => commitItems()}
              onChange={(event) => updateItemDraft(index, event.target.value)}
            />
            <button className="text-button danger" disabled={disabled} onClick={() => removeItem(index)}>
              移除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function CustomerPage({ customers, onSave }: { customers: Customer[]; onSave: (customer: Customer) => Promise<void> }) {
  const [draft, setDraft] = useState<Customer>(customers[0] || emptyCustomer());
  useEffect(() => {
    setDraft(customers[0] || emptyCustomer());
  }, [customers]);
  const columns: Array<DataTableColumn<Customer>> = [
    {
      key: 'name',
      title: '客户名称',
      width: 'minmax(180px, 1.4fr)',
      render: (item) => <strong className="table-link">{item.name || '未命名客户'}</strong>,
    },
    { key: 'contact', title: '联系人', width: '140px', render: (item) => item.contact.name || '-' },
    { key: 'phone', title: '电话', width: '150px', render: (item) => item.contact.phone || '-' },
    { key: 'email', title: '邮箱', width: 'minmax(180px, 1.3fr)', render: (item) => item.contact.email || '-' },
    { key: 'notes', title: '备注', width: 'minmax(220px, 1.6fr)', render: (item) => item.notes || '-' },
  ];
  return (
    <MasterDataPage
      title="客户"
      description="客户主数据供客户需求引用"
      items={customers}
      columns={columns}
      getTitle={(item) => item.name}
      getSearchText={(item) => `${item.name} ${item.contact.name} ${item.contact.phone} ${item.contact.email} ${item.notes || ''}`}
      selectedId={draft.id}
      onSelect={(item) => setDraft(item)}
      onNew={() => setDraft(emptyCustomer())}
    >
      <Field label="客户名称" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
      <Field label="联系人" value={draft.contact.name} onChange={(name) => setDraft({ ...draft, contact: { ...draft.contact, name } })} />
      <Field label="电话" value={draft.contact.phone} onChange={(phone) => setDraft({ ...draft, contact: { ...draft.contact, phone } })} />
      <Field label="邮箱" value={draft.contact.email} onChange={(email) => setDraft({ ...draft, contact: { ...draft.contact, email } })} />
      <TextArea label="备注" value={draft.notes || ''} onChange={(notes) => setDraft({ ...draft, notes })} />
      <button className="primary-button" onClick={() => void onSave(draft)}>
        保存客户
      </button>
    </MasterDataPage>
  );
}

function SubsceneStateEditor({
  globalFields,
  version,
  materials,
  readOnly,
  storageStatus,
  upload,
  onUploadImage,
  onSave,
}: {
  globalFields: GlobalField[];
  version: SubsceneVersion;
  materials: SubsceneVersion['materials'];
  readOnly: boolean;
  storageStatus: AttachmentStorageStatus;
  upload: { fileName: string; progress: number } | null;
  onUploadImage: (file: File) => Promise<RequirementAttachment | undefined>;
  onSave: (patch: Partial<SubsceneVersion>) => void;
}) {
  const rows = initialStateRows(version.objectStates.initial);
  const targetRows = targetStateRows(version.objectStates.target);
  const materialInitialRandomRows = materialInitialRandomizationRows(version.randomization);
  const materialOptions = materials.map((material) => material.type);
  const [expandedInitialRows, setExpandedInitialRows] = useState<Record<number, boolean>>({});
  const [expandedTargetRows, setExpandedTargetRows] = useState<Record<number, boolean>>({});
  const [expandedRandomRows, setExpandedRandomRows] = useState<Record<number, boolean>>({});

  function valuesForGroup(group: GlobalFieldGroup, currentValues: string[] = []): string[] {
    return fieldOptions(globalFields, group, currentValues).map((option) => option.value);
  }

  function saveRows(nextRows: InitialLocationRow[]) {
    if (readOnly) return;
    onSave({ objectStates: { ...version.objectStates, initial: initialStatesFromRows(nextRows) } });
  }

  function updateRow(index: number, patch: Partial<InitialLocationRow>) {
    saveRows(rows.map((row, currentIndex) => (currentIndex === index ? { ...row, ...patch } : row)));
  }

  function saveTargetRows(nextRows: TargetStateRow[]) {
    if (readOnly) return;
    onSave({ objectStates: { ...version.objectStates, target: targetStatesFromRows(nextRows) } });
  }

  function updateTargetRow(index: number, patch: Partial<TargetStateRow>) {
    saveTargetRows(targetRows.map((row, currentIndex) => (currentIndex === index ? { ...row, ...patch } : row)));
  }

  function saveMaterialInitialRandomRows(nextRows: MaterialInitialRandomizationRow[]) {
    if (readOnly) return;
    onSave({
      randomization: {
        ...version.randomization,
        materialInitialState: { rules: materialInitialRandomizationFromRows(nextRows) },
      },
    });
  }

  function updateMaterialInitialRandomRow(index: number, patch: Partial<MaterialInitialRandomizationRow>) {
    saveMaterialInitialRandomRows(materialInitialRandomRows.map((row, currentIndex) => (currentIndex === index ? { ...row, ...patch } : row)));
  }

  async function bindUploadedImage(target: StateImageUploadTarget, file: File) {
    if (!file.type.startsWith('image/')) {
      window.alert('这里只能上传图片');
      return;
    }
    const attachment = await onUploadImage(file);
    if (!attachment) return;
    if (target.kind === 'initial') {
      const row = rows[target.index];
      updateRow(target.index, { exampleImageAttachmentIds: [...row.exampleImageAttachmentIds, attachment.id] });
    }
    if (target.kind === 'target') {
      const row = targetRows[target.index];
      updateTargetRow(target.index, { exampleImageAttachmentIds: [...row.exampleImageAttachmentIds, attachment.id] });
    }
    if (target.kind === 'randomization') {
      const row = materialInitialRandomRows[target.index];
      updateMaterialInitialRandomRow(target.index, { exampleImageAttachmentIds: [...row.exampleImageAttachmentIds, attachment.id] });
    }
  }

  function unbindImage(target: StateImageUploadTarget, attachmentId: string) {
    if (target.kind === 'initial') {
      const row = rows[target.index];
      updateRow(target.index, { exampleImageAttachmentIds: row.exampleImageAttachmentIds.filter((id) => id !== attachmentId) });
    }
    if (target.kind === 'target') {
      const row = targetRows[target.index];
      updateTargetRow(target.index, { exampleImageAttachmentIds: row.exampleImageAttachmentIds.filter((id) => id !== attachmentId) });
    }
    if (target.kind === 'randomization') {
      const row = materialInitialRandomRows[target.index];
      updateMaterialInitialRandomRow(target.index, { exampleImageAttachmentIds: row.exampleImageAttachmentIds.filter((id) => id !== attachmentId) });
    }
  }

  function stateDetailEditor<T extends InitialLocationRow>({
    row,
    index,
    update,
  }: {
    row: T;
    index: number;
    update: (index: number, patch: Partial<T>) => void;
  }) {
    return (
      <div className="state-card-detail">
        <section>
          <h4>位置关系</h4>
          <div className="row-detail-grid">
            <label>
              <span>放在/靠近什么</span>
              <SingleEnumSelect
                value={row.primaryReferences}
                options={valuesForGroup('reference_object', row.primaryReferences)}
                placeholder="选择参照物"
                disabled={readOnly}
                allowCustom
                onChange={(primaryReferences) => update(index, { primaryReferences } as Partial<T>)}
              />
            </label>
            <label>
              <span>在它的哪里</span>
              <SingleEnumSelect
                value={row.primaryRelativePositions}
                options={valuesForGroup('relative_position', row.primaryRelativePositions)}
                placeholder="选择相对位置"
                disabled={readOnly}
                allowCustom
                onChange={(primaryRelativePositions) => update(index, { primaryRelativePositions } as Partial<T>)}
              />
            </label>
            <label>
              <span>接触哪个面</span>
              <SingleEnumSelect
                value={row.supportSurfaces}
                options={valuesForGroup('support_surface', row.supportSurfaces)}
                placeholder="选择支撑面"
                disabled={readOnly}
                allowCustom
                onChange={(supportSurfaces) => update(index, { supportSurfaces } as Partial<T>)}
              />
            </label>
          </div>
        </section>
        <section>
          <h4>更具体的位置</h4>
          <div className="row-detail-grid">
            <label>
              <span>区域</span>
              <MultiEnumInput
                value={row.regions}
                options={valuesForGroup('region', row.regions)}
                placeholder="选择区域"
                disabled={readOnly}
                allowCustom
                onChange={(regions) => update(index, { regions } as Partial<T>)}
              />
            </label>
            <label>
              <span>更靠近什么</span>
              <SingleEnumSelect
                value={row.secondaryReferences}
                options={valuesForGroup('reference_object', row.secondaryReferences)}
                placeholder="选择参照物"
                disabled={readOnly}
                allowCustom
                onChange={(secondaryReferences) => update(index, { secondaryReferences } as Partial<T>)}
              />
            </label>
            <label>
              <span>在它的哪里</span>
              <SingleEnumSelect
                value={row.secondaryRelativePositions}
                options={valuesForGroup('relative_position', row.secondaryRelativePositions)}
                placeholder="选择相对位置"
                disabled={readOnly}
                allowCustom
                onChange={(secondaryRelativePositions) => update(index, { secondaryRelativePositions } as Partial<T>)}
              />
            </label>
          </div>
        </section>
        <section>
          <h4>怎么放</h4>
          <div className="row-detail-grid">
            <label>
              <span>姿态</span>
              <MultiEnumInput
                value={row.poses}
                options={valuesForGroup('pose', row.poses)}
                placeholder="选择姿态"
                disabled={readOnly}
                allowCustom
                onChange={(poses) => update(index, { poses } as Partial<T>)}
              />
            </label>
            <label>
              <span>形态</span>
              <MultiEnumInput
                value={row.forms}
                options={valuesForGroup('form', row.forms)}
                placeholder="选择形态"
                disabled={readOnly}
                allowCustom
                onChange={(forms) => update(index, { forms } as Partial<T>)}
              />
            </label>
            <label>
              <span>参数</span>
              <MultiEnumInput
                value={row.parameters}
                options={valuesForGroup('parameter', row.parameters)}
                placeholder="选择参数"
                disabled={readOnly}
                allowCustom
                onChange={(parameters) => update(index, { parameters } as Partial<T>)}
              />
            </label>
          </div>
        </section>
        <section>
          <h4>补充说明</h4>
          <div className="row-detail-grid">
            <label className="row-detail-wide">
              <span>给采集员看的说明</span>
              <LongTextDialogEditor
                title="采集员说明"
                value={row.collectorInstruction}
                disabled={readOnly}
                placeholder="例如：牙刷可以放在洗手池台面左侧或右侧，但不要放进水槽里。"
                onChange={(collectorInstruction) => update(index, { collectorInstruction } as Partial<T>)}
              />
            </label>
            <label className="row-detail-wide">
              <span>限制条件</span>
              <LongTextDialogEditor
                title="物料状态限制条件"
                value={joinEnum(row.constraints)}
                disabled={readOnly}
                placeholder="限制条件"
                onChange={(constraints) => update(index, { constraints: splitEnum(constraints) } as Partial<T>)}
              />
            </label>
          </div>
        </section>
      </div>
    );
  }

  function imagePanel(target: StateImageUploadTarget, imageIds: string[]) {
    const images = imageIds
      .map((id) => version.attachments?.find((attachment) => attachment.id === id))
      .filter(Boolean) as RequirementAttachment[];
    const disabled = readOnly || Boolean(upload) || !storageStatus.enabled;
    return (
      <div className="state-image-panel">
        <div className="state-image-header">
          <span>示例图片</span>
          <label className={`ghost-button file-label ${disabled ? 'disabled' : ''}`} title={!storageStatus.enabled ? storageStatus.message : undefined}>
            上传图片
            <input
              type="file"
              hidden
              accept="image/*"
              disabled={disabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void bindUploadedImage(target, file);
              }}
            />
          </label>
        </div>
        {!storageStatus.enabled && <p className="state-image-warning">{storageStatus.message}</p>}
        {upload && <p className="state-image-warning">正在上传 {upload.fileName}：{upload.progress}%</p>}
        {images.length === 0 ? (
          <p className="state-image-empty">暂无示例图</p>
        ) : (
          <div className="state-image-list">
            {images.map((image) => (
              <div className="state-image-item" key={image.id}>
                <AttachmentThumbnail attachment={image} publicBaseUrl={storageStatus.publicBaseUrl} />
                <button type="button" className="text-button danger state-image-remove" disabled={readOnly} onClick={() => unbindImage(target, image.id)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function stateCard<T extends InitialLocationRow>({
    row,
    index,
    kind,
    expanded,
    toggleExpanded,
    update,
    remove,
  }: {
    row: T;
    index: number;
    kind: 'initial' | 'target';
    expanded: boolean;
    toggleExpanded: (index: number) => void;
    update: (index: number, patch: Partial<T>) => void;
    remove: (index: number) => void;
  }) {
    return (
      <section className="state-card">
        <div className="state-card-main">
          <div className="state-card-top">
            <label>
              <span>物料</span>
              <select value={row.object} disabled={readOnly} onChange={(event) => update(index, { object: event.target.value } as Partial<T>)}>
                <option value="">选择物料</option>
                {Array.from(new Set([...materialOptions, row.object].filter(Boolean))).map((option) => (
                  <option value={option} key={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <div className="state-card-actions">
              <button type="button" className="ghost-button" onClick={() => toggleExpanded(index)}>
                {expanded ? '收起字段' : '展开编辑'}
              </button>
              <button type="button" className="text-button danger" disabled={readOnly} onClick={() => remove(index)}>
                移除
              </button>
            </div>
          </div>
          <p className="state-human-summary">{stateSentence(row)}</p>
          {row.collectorInstruction && <p className="state-instruction">采集员说明：{row.collectorInstruction}</p>}
          {expanded && stateDetailEditor({ row, index, update })}
        </div>
        {imagePanel({ kind, index }, row.exampleImageAttachmentIds)}
      </section>
    );
  }

  function stateCardList<T extends InitialLocationRow>({
    title,
    description,
    items,
    kind,
    expandedRows,
    toggleExpanded,
    update,
    remove,
    add,
    emptyText,
  }: {
    title: string;
    description: string;
    items: T[];
    kind: 'initial' | 'target';
    expandedRows: Record<number, boolean>;
    toggleExpanded: (index: number) => void;
    update: (index: number, patch: Partial<T>) => void;
    remove: (index: number) => void;
    add: () => void;
    emptyText: string;
  }) {
    return (
      <div className="embedded-table state-card-section">
        <div className="embedded-table-header">
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
          <button className="primary-button" disabled={readOnly} onClick={add}>
            添加状态
          </button>
        </div>
        {items.length === 0 ? (
          <div className="state-card-empty">{emptyText}</div>
        ) : (
          <div className="state-card-list">
            {items.map((row, index) =>
              stateCard({
                row,
                index,
                kind,
                expanded: expandedRows[index] ?? !readOnly,
                toggleExpanded,
                update,
                remove,
              }),
            )}
          </div>
        )}
      </div>
    );
  }

  function randomizationCard(row: MaterialInitialRandomizationRow, index: number) {
    const expanded = expandedRandomRows[index] ?? !readOnly;
    return (
      <section className="state-card">
        <div className="state-card-main">
          <div className="state-card-top">
            <div>
              <h4>物料状态随机性 {index + 1}</h4>
              <p className="state-human-summary">{materialRandomizationSentence(row)}</p>
            </div>
            <div className="state-card-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setExpandedRandomRows((current) => ({ ...current, [index]: !expanded }))}
              >
                {expanded ? '收起字段' : '展开编辑'}
              </button>
              <button
                type="button"
                className="text-button danger"
                disabled={readOnly}
                onClick={() => saveMaterialInitialRandomRows(materialInitialRandomRows.filter((_, currentIndex) => currentIndex !== index))}
              >
                移除
              </button>
            </div>
          </div>
          {row.collectorInstruction && <p className="state-instruction">采集员说明：{row.collectorInstruction}</p>}
          {expanded && (
            <div className="state-card-detail">
              <section>
                <h4>怎么随机</h4>
                <div className="row-detail-grid">
                  <label>
                    <span>哪些物料</span>
                    <MultiEnumInput
                      value={row.targetMaterials}
                      options={materialOptions}
                      placeholder="选择物料"
                      disabled={readOnly}
                      onChange={(targetMaterials) => updateMaterialInitialRandomRow(index, { targetMaterials })}
                    />
                  </label>
                  <label>
                    <span>每 N 条换一次</span>
                    <input
                      type="number"
                      min={1}
                      value={row.changeIntervalRecords || 1}
                      disabled={readOnly}
                      onChange={(event) => updateMaterialInitialRandomRow(index, { changeIntervalRecords: Number(event.target.value) || 1 })}
                    />
                  </label>
                  <label>
                    <span>需要变化什么</span>
                    <MultiSelectInput
                      value={row.randomizedFields}
                      options={uniqueOptions([
                        ...fieldOptions(globalFields, 'material_random_field', row.randomizedFields),
                        ...fallbackMaterialRandomOptions,
                      ])}
                      disabled={readOnly}
                      onChange={(randomizedFields) => updateMaterialInitialRandomRow(index, { randomizedFields })}
                    />
                  </label>
                </div>
              </section>
              <section>
                <h4>补充说明</h4>
                <div className="row-detail-grid">
                  <label className="row-detail-wide">
                    <span>给采集员看的说明</span>
                    <LongTextDialogEditor
                      title="物料状态随机性说明"
                      value={row.collectorInstruction}
                      disabled={readOnly}
                      placeholder="例如：牙刷每条都换到洗手池台面不同区域，不要放进水槽内。"
                      onChange={(collectorInstruction) => updateMaterialInitialRandomRow(index, { collectorInstruction })}
                    />
                  </label>
                  <label className="row-detail-wide">
                    <span>限制条件</span>
                    <LongTextDialogEditor
                      title="物料初始状态随机性限制条件"
                      value={row.constraints}
                      disabled={readOnly}
                      placeholder="限制条件"
                      onChange={(constraints) => updateMaterialInitialRandomRow(index, { constraints })}
                    />
                  </label>
                </div>
              </section>
            </div>
          )}
        </div>
        {imagePanel({ kind: 'randomization', index }, row.exampleImageAttachmentIds)}
      </section>
    );
  }

  return (
    <div className="state-editor">
      {stateCardList<InitialLocationRow>({
        title: '物料初始状态',
        description: '给采集员看的位置和摆放要求，先看一句话和图片，需要时再展开字段',
        items: rows,
        kind: 'initial',
        expandedRows: expandedInitialRows,
        toggleExpanded: (index) => setExpandedInitialRows((current) => ({ ...current, [index]: !current[index] })),
        update: updateRow,
        remove: (index) => saveRows(rows.filter((_, currentIndex) => currentIndex !== index)),
        add: () => saveRows([...rows, emptyInitialLocationRow(materialOptions[0] || '')]),
        emptyText: '暂无物料初始状态',
      })}
      {stateCardList<TargetStateRow>({
        title: '物料目标状态',
        description: '描述操作完成后物料应该变成什么样',
        items: targetRows,
        kind: 'target',
        expandedRows: expandedTargetRows,
        toggleExpanded: (index) => setExpandedTargetRows((current) => ({ ...current, [index]: !current[index] })),
        update: updateTargetRow,
        remove: (index) => saveTargetRows(targetRows.filter((_, currentIndex) => currentIndex !== index)),
        add: () => saveTargetRows([...targetRows, emptyTargetStateRow(materialOptions[0] || '')]),
        emptyText: '暂无物料目标状态',
      })}
      <div className="embedded-table state-card-section">
        <div className="embedded-table-header">
          <div>
            <h3>物料初始状态随机性</h3>
            <p>说明哪些物料要随机变化、每几条变一次，以及变化到什么范围算合格</p>
          </div>
          <button
            className="primary-button"
            disabled={readOnly}
            onClick={() =>
              saveMaterialInitialRandomRows([
                ...materialInitialRandomRows,
                {
                  targetMaterials: materialOptions[0] ? [materialOptions[0]] : [],
                  changeIntervalRecords: 1,
                  randomizedFields: [],
                  collectorInstruction: '',
                  exampleImageAttachmentIds: [],
                  constraints: '',
                },
              ])
            }
          >
            添加随机性
          </button>
        </div>
        {materialInitialRandomRows.length === 0 ? (
          <div className="state-card-empty">暂无物料初始状态随机性</div>
        ) : (
          <div className="state-card-list">
            {materialInitialRandomRows.map((row, index) => (
              <div key={`material-initial-random-${index}`}>{randomizationCard(row, index)}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MaterialPage({
  materials,
  storageStatus,
  onMaterialsChange,
  onSave,
}: {
  materials: Material[];
  storageStatus: AttachmentStorageStatus;
  onMaterialsChange: (materials: Material[]) => void;
  onSave: (material: Material) => Promise<boolean>;
}) {
  const nextSkuId = nextReadableId(
    materials.map((material) => material.skuId),
    'SKU',
  );
  const [draft, setDraft] = useState<Material>(materials[0] || emptyMaterial(nextSkuId));
  const [imageUpload, setImageUpload] = useState<{ fileName: string; progress: number } | null>(null);
  useEffect(() => {
    setDraft(materials[0] || emptyMaterial(nextSkuId));
  }, [materials, nextSkuId]);

  async function uploadMaterialImage(file: File) {
    if (!draft.id) {
      window.alert('请先保存物料，再上传图片');
      return;
    }
    if (!file.type.startsWith('image/')) {
      window.alert('只能上传图片文件');
      return;
    }
    if (file.size > 1024 * 1024 * 1024) {
      window.alert('单张图片不能超过 1G');
      return;
    }
    let uploadInit: AttachmentUploadInit | undefined;
    try {
      setImageUpload({ fileName: file.name, progress: 0 });
      uploadInit = await api.initMaterialImageUpload(draft.id, file);
      const parts: AttachmentUploadPart[] = [];
      const totalParts = Math.ceil(file.size / uploadInit.partSize);
      for (let index = 0; index < totalParts; index += 1) {
        const start = index * uploadInit.partSize;
        const end = Math.min(file.size, start + uploadInit.partSize);
        const part = await api.uploadMaterialImagePart(
          draft.id,
          uploadInit.uploadId,
          uploadInit.storageKey,
          index + 1,
          file.slice(start, end, file.type || 'application/octet-stream'),
        );
        parts.push({ partNumber: index + 1, etag: part.etag });
        setImageUpload({ fileName: file.name, progress: Math.round(((index + 1) / totalParts) * 100) });
      }
      await api.completeMaterialImageUpload(draft.id, uploadInit.attachmentId, uploadInit.uploadId, uploadInit.storageKey, parts);
      const nextData = await api.data();
      onMaterialsChange(nextData.materials);
      const nextDraft = nextData.materials.find((item) => item.id === draft.id);
      if (nextDraft) setDraft(nextDraft);
    } catch (error) {
      if (uploadInit) {
        await api.abortMaterialImageUpload(draft.id, uploadInit.attachmentId, uploadInit.uploadId, uploadInit.storageKey).catch(() => undefined);
      }
      throw error;
    } finally {
      setImageUpload(null);
    }
  }

  async function deleteMaterialImage(attachmentId: string) {
    if (!draft.id) return;
    const materials = await api.deleteMaterialImage(draft.id, attachmentId);
    onMaterialsChange(materials);
    const nextDraft = materials.find((item) => item.id === draft.id);
    if (nextDraft) setDraft(nextDraft);
  }

  const columns: Array<DataTableColumn<Material>> = [
    {
      key: 'skuId',
      title: 'SKU 编号',
      width: '180px',
      allowOverflow: true,
      render: (item) => (
        <span className="sku-with-image material-list-sku">
          <strong className="table-link">{item.skuId || '-'}</strong>
          {item.images?.[0] && <AttachmentThumbnail attachment={item.images[0]} publicBaseUrl={storageStatus.publicBaseUrl} />}
        </span>
      ),
    },
    { key: 'type', title: '物料类型', width: 'minmax(140px, 1.2fr)', render: (item) => item.type || '-' },
    { key: 'color', title: '颜色', width: '110px', render: (item) => item.color || '-' },
    { key: 'material', title: '材质', width: '130px', render: (item) => item.material || '-' },
    { key: 'packageType', title: '包装类型', width: '130px', render: (item) => item.packageType || '-' },
    { key: 'size', title: '尺寸', width: 'minmax(180px, 1.4fr)', render: (item) => item.size || '-' },
    { key: 'weight', title: '重量', width: '100px', render: (item) => item.weight || '-' },
  ];
  return (
    <MasterDataPage
      title="物料"
      description="物料主数据通过 SKU 供任务 SOP 引用"
      items={materials}
      columns={columns}
      getTitle={(item) => `${item.skuId} ${item.type}`}
      getSearchText={(item) =>
        `${item.skuId} ${item.type} ${item.color} ${item.material} ${item.packageType} ${item.size || ''} ${item.weight || ''}`
      }
      selectedId={draft.id}
      onSelect={(item) => setDraft(item)}
      onNew={() => setDraft(emptyMaterial(nextSkuId))}
    >
      {(closeEditor) => (
        <>
          <Field label="SKU 编号" value={draft.skuId} disabled onChange={() => undefined} />
          {!draft.id && <p className="field-note">SKU 由系统自动生成，保存时会按最新数据确认最终编号。</p>}
          <AttachmentField
            title="物料图片"
            hint="支持上传图片，单张不超过 1G"
            uploadLabel="上传图片"
            emptyText="暂无图片"
            accept="image/*"
            attachments={draft.images || []}
            disabled={!draft.id}
            storageStatus={draft.id ? storageStatus : { enabled: false, message: '请先保存物料，再上传图片。' }}
            upload={imageUpload}
            onUpload={uploadMaterialImage}
            onDownload={(attachment) => downloadStoredAttachment(attachment)}
            onDelete={deleteMaterialImage}
          />
          <div className="material-detail-grid">
            <Field label="物料类型" value={draft.type} onChange={(type) => setDraft({ ...draft, type })} />
            <Field label="颜色" value={draft.color} onChange={(color) => setDraft({ ...draft, color })} />
            <Field label="材质" value={draft.material} onChange={(material) => setDraft({ ...draft, material })} />
            <Field label="包装类型" value={draft.packageType} onChange={(packageType) => setDraft({ ...draft, packageType })} />
            <Field label="尺寸" value={draft.size || ''} onChange={(size) => setDraft({ ...draft, size })} />
            <Field label="重量" value={draft.weight || ''} onChange={(weight) => setDraft({ ...draft, weight })} />
          </div>
          <button
            className="primary-button"
            onClick={async () => {
              const saved = await onSave(draft.id ? draft : { ...draft, skuId: '' });
              if (saved) {
                closeEditor();
              }
            }}
          >
            保存物料
          </button>
        </>
      )}
    </MasterDataPage>
  );
}

function RobotPage({ robots, onSave }: { robots: RobotModel[]; onSave: (robot: RobotModel) => Promise<void> }) {
  const [draft, setDraft] = useState<RobotModel>(robots[0] || emptyRobot());
  useEffect(() => {
    setDraft(robots[0] || emptyRobot());
  }, [robots]);
  const columns: Array<DataTableColumn<RobotModel>> = [
    {
      key: 'model',
      title: '型号',
      width: 'minmax(160px, 1.4fr)',
      render: (item) => <strong className="table-link">{item.model || '未命名型号'}</strong>,
    },
    { key: 'brand', title: '品牌', width: '140px', render: (item) => item.brand || '-' },
    { key: 'terminal', title: '末端', width: '160px', render: (item) => item.terminal || '-' },
    {
      key: 'topics',
      title: 'Topic 数',
      width: '100px',
      render: (item) => Object.keys(item.topics).length,
    },
  ];
  return (
    <MasterDataPage
      title="机器型号"
      description="机器型号供客户需求选择，topic 要求可在详情中维护"
      items={robots}
      columns={columns}
      getTitle={(item) => item.model}
      getSearchText={(item) =>
        `${item.brand} ${item.model} ${item.terminal} ${Object.keys(item.topics).join(' ')}`
      }
      selectedId={draft.id}
      onSelect={(item) => setDraft(item)}
      onNew={() => setDraft(emptyRobot())}
    >
      <Field label="品牌" value={draft.brand} onChange={(brand) => setDraft({ ...draft, brand })} />
      <Field label="型号" value={draft.model} onChange={(model) => setDraft({ ...draft, model })} />
      <Field label="末端" value={draft.terminal} onChange={(terminal) => setDraft({ ...draft, terminal })} />
      <TextArea
        label="Topic（key:value，一行一个）"
        value={Object.entries(draft.topics)
          .map(([key, value]) => `${key}:${value}`)
          .join('\n')}
        onChange={(value) => setDraft({ ...draft, topics: keyValueLines(value) })}
      />
      <button className="primary-button" onClick={() => void onSave(draft)}>
        保存型号
      </button>
    </MasterDataPage>
  );
}

function MasterDataPage<T extends { id: string }>({
  title,
  description,
  items,
  columns,
  getTitle,
  getSearchText,
  selectedId,
  onSelect,
  onNew,
  children,
}: {
  title: string;
  description: string;
  items: T[];
  columns: Array<DataTableColumn<T>>;
  getTitle: (item: T) => string;
  getSearchText: (item: T) => string;
  selectedId: string;
  onSelect: (item: T) => void;
  onNew: () => void;
  children: ReactNode | ((closeEditor: () => void) => ReactNode);
}) {
  const [query, setQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const filteredItems = items.filter((item) => matchesQuery(query, [item.id, getTitle(item), getSearchText(item)]));

  function openItemEditor(item: T) {
    onSelect(item);
    setEditorOpen(true);
  }

  function openNewItemEditor() {
    onNew();
    setEditorOpen(true);
  }

  return (
    <div className="page-stack">
      <section className="panel table-panel">
        <SearchPanel
          title={`${title}列表`}
          description={description}
          query={query}
          placeholder={`搜索${title}名称、编号或字段`}
          count={filteredItems.length}
          onQueryChange={setQuery}
          actions={
            <button className="primary-button" onClick={openNewItemEditor}>
              新建{title}
            </button>
          }
        />
        <DataTable
          rows={filteredItems}
          columns={columns}
          rowKey={(item) => item.id || getTitle(item)}
          selectedKey={selectedId}
          emptyText={`没有匹配的${title}`}
          onRowClick={openItemEditor}
        />
      </section>
      {editorOpen && (
        <Modal title={`${title}详情`} onClose={() => setEditorOpen(false)}>
          <div className="form-stack modal-form-stack">
            {typeof children === 'function' ? children(() => setEditorOpen(false)) : children}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  disabled = false,
}: {
  label: string;
  value: string;
  type?: 'text' | 'number' | 'date';
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    if (draft !== value) {
      onChange(draft);
    }
  }

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={draft}
        disabled={disabled}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composingRef.current) {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function CommitField({
  label,
  value,
  onChange,
  type = 'text',
  disabled = false,
}: {
  label: string;
  value: string;
  type?: 'text' | 'number' | 'date';
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    const nextValue = draft.trim();
    if (nextValue !== value) {
      onChange(nextValue);
    }
  }

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={draft}
        disabled={disabled}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composingRef.current) {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function InlineTextInput({
  value,
  placeholder = '',
  disabled = false,
  className = '',
  onCommit,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    const nextValue = draft.trim();
    if (nextValue !== value) {
      onCommit(nextValue);
    }
  }

  return (
    <input
      className={className}
      type="text"
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        setDraft(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !composingRef.current) {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function InlineNumberInput({
  value,
  disabled = false,
  min = 0,
  className = '',
  onCommit,
}: {
  value: number;
  disabled?: boolean;
  min?: number;
  className?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const nextValue = Number(draft);
    const normalizedValue = Number.isFinite(nextValue) ? Math.max(min, nextValue) : min;
    const normalizedDraft = String(normalizedValue);
    setDraft(normalizedDraft);
    if (normalizedValue !== value) {
      onCommit(normalizedValue);
    }
  }

  return (
    <input
      className={className}
      type="number"
      min={min}
      value={draft}
      disabled={disabled}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function SelectField({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextArea({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    if (draft !== value) {
      onChange(draft);
    }
  }

  return (
    <label className="field wide">
      <span>{label}</span>
      <textarea
        value={draft}
        disabled={disabled}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !composingRef.current) {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function AttachmentField({
  title = '客户附件',
  hint = '单个附件不超过 1G，支持分片上传',
  uploadLabel = '上传附件',
  emptyText = '暂无附件',
  accept,
  attachments,
  disabled,
  storageStatus = defaultAttachmentStorageStatus,
  upload,
  onUpload,
  onDownload,
  onDelete,
}: {
  title?: string;
  hint?: string;
  uploadLabel?: string;
  emptyText?: string;
  accept?: string;
  attachments: RequirementAttachment[];
  disabled: boolean;
  storageStatus?: AttachmentStorageStatus;
  upload: { fileName: string; progress: number } | null;
  onUpload: (file: File) => Promise<void>;
  onDownload: (attachment: RequirementAttachment) => Promise<void>;
  onDelete: (attachmentId: string) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewAttachment, setPreviewAttachment] = useState<RequirementAttachment | null>(null);
  const uploadDisabled = disabled || Boolean(upload) || !storageStatus.enabled;

  async function pickFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    for (const file of files) {
      await onUpload(file);
    }
  }

  return (
    <div className="attachment-field">
      <div className="attachment-panel">
        <div className="attachment-panel-header">
          <div>
            <strong>{title}</strong>
            <span>{hint}</span>
          </div>
          <button className="primary-button" disabled={uploadDisabled} title={!storageStatus.enabled ? storageStatus.message : undefined} onClick={() => inputRef.current?.click()}>
            {uploadLabel}
          </button>
          <input ref={inputRef} type="file" multiple hidden accept={accept} onChange={(event) => void pickFiles(event)} />
        </div>
        {!storageStatus.enabled && <div className="attachment-storage-warning">{storageStatus.message}</div>}
        {upload && (
          <div className="attachment-upload-progress">
            <span>{upload.fileName}</span>
            <progress value={upload.progress} max={100} />
            <strong>{upload.progress}%</strong>
          </div>
        )}
        {attachments.length === 0 ? (
          <div className="attachment-empty">{emptyText}</div>
        ) : (
          <div className="attachment-list">
            {attachments.map((attachment) => (
              <div className="attachment-row" key={attachment.id}>
                <div className="attachment-main">
                  <AttachmentPreviewThumb
                    attachment={attachment}
                    publicBaseUrl={storageStatus.publicBaseUrl}
                    onPreview={() => setPreviewAttachment(attachment)}
                  />
                  <div>
                    <button type="button" className="attachment-name-button" onClick={() => setPreviewAttachment(attachment)}>
                      {attachment.name}
                    </button>
                    <span>
                      {formatFileSize(attachment.size)} · {formatShortDate(attachment.uploadedAt)}
                    </span>
                  </div>
                </div>
                <div className="button-row">
                  <button className="text-button" onClick={() => setPreviewAttachment(attachment)}>
                    预览
                  </button>
                  <button className="text-button" onClick={() => void onDownload(attachment)}>
                    下载
                  </button>
                  <button className="text-button danger" disabled={disabled} onClick={() => void onDelete(attachment.id)}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {previewAttachment && (
        <AttachmentPreviewModal
          attachment={previewAttachment}
          publicBaseUrl={storageStatus.publicBaseUrl}
          onClose={() => setPreviewAttachment(null)}
          onDownload={() => onDownload(previewAttachment)}
        />
      )}
    </div>
  );
}

function AttachmentPreviewThumb({
  attachment,
  publicBaseUrl,
  onPreview,
  compact = false,
}: {
  attachment: RequirementAttachment;
  publicBaseUrl?: string;
  onPreview: () => void;
  compact?: boolean;
}) {
  const [url, setUrl] = useState('');
  const isImage = attachment.contentType.startsWith('image/');
  const isVideo = attachment.contentType.startsWith('video/');
  const publicUrl = isImage ? publicAttachmentUrl(publicBaseUrl, attachment.storageKey) : '';

  useEffect(() => {
    if (!isImage) {
      setUrl('');
      return undefined;
    }
    if (publicUrl) {
      setUrl(publicUrl);
      return undefined;
    }
    let active = true;
    let objectUrl = '';
    fetch(protectedAttachmentUrl(attachment.storageKey), { headers: apiHeaders() })
      .then((res) => (res.ok ? res.blob() : undefined))
      .then((blob) => {
        if (!blob || !active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.storageKey, isImage, publicUrl]);

  return (
    <button type="button" className={`attachment-preview-thumb ${compact ? 'compact' : ''}`} onClick={onPreview} title="点击预览">
      {isImage && url ? <img src={url} alt={attachment.name} /> : <span>{isVideo ? '视频' : isImage ? '图片' : '文件'}</span>}
    </button>
  );
}

function AttachmentPreviewModal({
  attachment,
  publicBaseUrl,
  onClose,
  onDownload,
}: {
  attachment: RequirementAttachment;
  publicBaseUrl?: string;
  onClose: () => void;
  onDownload: () => Promise<void>;
}) {
  const [objectUrl, setObjectUrl] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const isImage = attachment.contentType.startsWith('image/');
  const isVideo = attachment.contentType.startsWith('video/');
  const publicUrl = publicAttachmentUrl(publicBaseUrl, attachment.storageKey);
  const previewUrl = publicUrl || objectUrl;

  useEffect(() => {
    setLoadFailed(false);
    setObjectUrl('');
    if (publicUrl || (!isImage && !isVideo)) {
      return undefined;
    }
    let active = true;
    let localObjectUrl = '';
    fetch(protectedAttachmentUrl(attachment.storageKey), { headers: apiHeaders() })
      .then((res) => (res.ok ? res.blob() : undefined))
      .then((blob) => {
        if (!active) return;
        if (!blob) {
          setLoadFailed(true);
          return;
        }
        localObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(localObjectUrl);
      })
      .catch(() => setLoadFailed(true));
    return () => {
      active = false;
      if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
    };
  }, [attachment.storageKey, isImage, isVideo, publicUrl]);

  return (
    <Modal title={`预览：${attachment.name}`} panelClassName="attachment-preview-panel" onClose={onClose}>
      <div className="attachment-preview-modal">
        <div className="attachment-preview-stage">
          {isImage && previewUrl && <img src={previewUrl} alt={attachment.name} />}
          {isVideo && previewUrl && <video src={previewUrl} controls />}
          {(isImage || isVideo) && !previewUrl && !loadFailed && <div className="attachment-preview-fallback">正在加载预览...</div>}
          {(!isImage && !isVideo) && <div className="attachment-preview-fallback">当前文件类型不支持在线预览，可以下载后查看。</div>}
          {loadFailed && <div className="attachment-preview-fallback">预览加载失败，可以下载后查看。</div>}
        </div>
        <div className="attachment-preview-meta">
          <span>{attachment.contentType || '未知类型'}</span>
          <span>{formatFileSize(attachment.size)}</span>
          <span>{formatShortDate(attachment.uploadedAt)}</span>
        </div>
        <div className="form-actions">
          {publicUrl && (
            <a className="ghost-button" href={publicUrl} target="_blank" rel="noreferrer">
              新窗口打开
            </a>
          )}
          <button className="primary-button" onClick={() => void onDownload()}>
            下载
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AttachmentThumbnail({ attachment, publicBaseUrl }: { attachment: RequirementAttachment; publicBaseUrl?: string }) {
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <>
      <AttachmentPreviewThumb attachment={attachment} publicBaseUrl={publicBaseUrl} compact onPreview={() => setPreviewOpen(true)} />
      {previewOpen && (
        <AttachmentPreviewModal
          attachment={attachment}
          publicBaseUrl={publicBaseUrl}
          onClose={() => setPreviewOpen(false)}
          onDownload={() => downloadStoredAttachment(attachment)}
        />
      )}
    </>
  );
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

function splitList(value: string | undefined): string[] {
  return (value || '')
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function forbiddenGroupsFromKeys(keys: string[], options: Option[]): RequirementVersion['forbiddenOperations'] {
  const groups = new Map<string, Array<{ operation: string; note: string }>>();
  keys.forEach((operation) => {
    const option = options.find((item) => item.value === operation);
    const [category, ...rest] = operation.split('/');
    const hasCategory = rest.length > 0 && category.trim();
    const groupName = hasCategory ? category.trim() : '';
    const operationName = hasCategory ? rest.join('/').trim() : operation;
    const current = groups.get(groupName) || [];
    current.push({ operation: operationName, note: option?.description || '' });
    groups.set(groupName, current);
  });
  return Array.from(groups.entries()).map(([category, operations]) => ({ category, operations }));
}

function joinEnum(values: string[]): string {
  return values.filter(Boolean).join('、');
}

function splitEnum(value: string | undefined): string[] {
  return (value || '')
    .split(/[、，,\\/]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function emptyInitialLocationRow(object = ''): InitialLocationRow {
  return {
    object,
    primaryReferences: [],
    primaryRelativePositions: [],
    supportSurfaces: [],
    regions: [],
    secondaryReferences: [],
    secondaryRelativePositions: [],
    poses: [],
    forms: [],
    parameters: [],
    collectorInstruction: '',
    exampleImageAttachmentIds: [],
    constraints: [],
  };
}

function initialStateRows(states: SubsceneVersion['objectStates']['initial']): InitialLocationRow[] {
  return states.flatMap((state) =>
    state.allowedLocations.map((location) => {
      const primary = location.referencePath.find((item) => item.level === 1);
      const secondary = location.referencePath.find((item) => item.level === 2);
      return {
        object: state.object,
        primaryReferences: splitEnum(primary?.referenceObject),
        primaryRelativePositions: splitEnum(primary?.relativePosition),
        supportSurfaces: splitEnum(location.supportSurface),
        regions: location.allowedRegions,
        secondaryReferences: splitEnum(secondary?.referenceObject),
        secondaryRelativePositions: splitEnum(secondary?.relativePosition),
        poses: location.allowedPose,
        forms: location.allowedForm,
        parameters: (location as { parameters?: string[] }).parameters || [],
        collectorInstruction: location.collectorInstruction || '',
        exampleImageAttachmentIds: location.exampleImageAttachmentIds || [],
        constraints: location.constraints,
      };
    }),
  );
}

function initialStatesFromRows(rows: InitialLocationRow[]): SubsceneVersion['objectStates']['initial'] {
  const states = new Map<string, SubsceneVersion['objectStates']['initial'][number]>();
  for (const row of rows) {
    if (!row.object) continue;
    const current = states.get(row.object) || { object: row.object, allowedLocations: [] };
    const referencePath = [
      row.primaryReferences.length || row.primaryRelativePositions.length
        ? {
            level: 1,
            referenceObject: joinEnum(row.primaryReferences),
            relativePosition: joinEnum(row.primaryRelativePositions),
          }
        : undefined,
      row.secondaryReferences.length || row.secondaryRelativePositions.length
        ? {
            level: 2,
            referenceObject: joinEnum(row.secondaryReferences),
            relativePosition: joinEnum(row.secondaryRelativePositions),
          }
        : undefined,
    ].filter(Boolean) as SubsceneVersion['objectStates']['initial'][number]['allowedLocations'][number]['referencePath'];
    current.allowedLocations.push({
      location: joinEnum([...row.primaryReferences, ...row.primaryRelativePositions, ...row.regions]),
      referencePath,
      supportSurface: joinEnum(row.supportSurfaces),
      allowedRegions: row.regions,
      allowedPose: row.poses,
      allowedForm: row.forms,
      parameters: row.parameters,
      collectorInstruction: row.collectorInstruction,
      exampleImageAttachmentIds: row.exampleImageAttachmentIds,
      constraints: row.constraints,
    });
    states.set(row.object, current);
  }
  return Array.from(states.values());
}

function targetStateRows(states: SubsceneVersion['objectStates']['target']): TargetStateRow[] {
  return states.map((state) => {
    const primary = state.referencePath?.find((item) => item.level === 1);
    const secondary = state.referencePath?.find((item) => item.level === 2);
    return {
      object: state.object,
      primaryReferences: splitEnum(primary?.referenceObject || state.requiredLocation),
      primaryRelativePositions: splitEnum(primary?.relativePosition),
      supportSurfaces: splitEnum(state.supportSurface),
      regions: state.requiredRegions,
      secondaryReferences: splitEnum(secondary?.referenceObject),
      secondaryRelativePositions: splitEnum(secondary?.relativePosition),
      poses: state.requiredPose,
      forms: state.requiredForm,
      parameters: state.parameters || [],
      collectorInstruction: state.collectorInstruction || '',
      exampleImageAttachmentIds: state.exampleImageAttachmentIds || [],
      constraints: state.constraints || [],
    };
  });
}

function targetStatesFromRows(rows: TargetStateRow[]): SubsceneVersion['objectStates']['target'] {
  return rows
    .filter((row) => row.object)
    .map((row) => {
      const referencePath = [
        row.primaryReferences.length || row.primaryRelativePositions.length
          ? {
              level: 1,
              referenceObject: joinEnum(row.primaryReferences),
              relativePosition: joinEnum(row.primaryRelativePositions),
            }
          : undefined,
        row.secondaryReferences.length || row.secondaryRelativePositions.length
          ? {
              level: 2,
              referenceObject: joinEnum(row.secondaryReferences),
              relativePosition: joinEnum(row.secondaryRelativePositions),
            }
          : undefined,
      ].filter(Boolean) as NonNullable<SubsceneVersion['objectStates']['target'][number]['referencePath']>;
      return {
        object: row.object,
        requiredLocation: joinEnum([...row.primaryReferences, ...row.primaryRelativePositions, ...row.regions]),
        requiredRegions: row.regions,
        requiredPose: row.poses,
        requiredForm: row.forms,
        referencePath,
        supportSurface: joinEnum(row.supportSurfaces),
        parameters: row.parameters,
        collectorInstruction: row.collectorInstruction,
        exampleImageAttachmentIds: row.exampleImageAttachmentIds,
        constraints: row.constraints,
      };
    });
}

function emptyTargetStateRow(object = ''): TargetStateRow {
  return emptyInitialLocationRow(object);
}

function robotInitialRandomizationRows(
  randomization: SubsceneVersion['randomization'],
  legacyFrequency?: string,
): RobotInitialRandomizationRow[] {
  const robotInitialState = randomization.robotInitialState;
  if (!robotInitialState.enabled && robotInitialState.randomizedFields.length === 0) {
    return [];
  }
  const constraints = Array.from(new Set(robotInitialState.randomizedFields.flatMap((field) => field.constraints))).filter(Boolean);
  return [
    {
      target: '机器人初始态',
      changeIntervalRecords: robotInitialState.changeIntervalRecords || Number(legacyFrequency) || 1,
      randomizedFields: robotInitialState.randomizedFields.map((field) => field.field),
      constraints: joinEnum(constraints),
    },
  ];
}

function robotInitialRandomizationPatch(
  version: SubsceneVersion,
  rows: RobotInitialRandomizationRow[],
): Partial<SubsceneVersion> {
  const row = rows[0];
  const randomizedFields = row
    ? row.randomizedFields.map((field) => ({
        field,
        displayName: field,
        constraints: splitEnum(row.constraints),
      }))
    : [];
  const changeIntervalRecords = row?.changeIntervalRecords || 1;
  return {
    robotInitialRandomizationRequirements: row?.randomizedFields || [],
    randomizationFrequency: String(changeIntervalRecords),
    randomization: {
      ...version.randomization,
      robotInitialState: {
        ...version.randomization.robotInitialState,
        enabled: Boolean(row),
        changeFrequency: 'every_n_records',
        changeIntervalRecords,
        randomizedFields,
      },
    },
  };
}

function materialInitialRandomizationRows(randomization: SubsceneVersion['randomization']): MaterialInitialRandomizationRow[] {
  return randomization.materialInitialState.rules.map((rule) => ({
    targetMaterials: rule.targetMaterials,
    changeIntervalRecords: rule.changeIntervalRecords || 1,
    randomizedFields: [
      ...rule.randomizedFields.locations.map((item) => item.name),
      ...rule.randomizedFields.poses.map((item) => item.name),
      ...rule.randomizedFields.forms.map((item) => item.name),
    ],
    collectorInstruction: rule.collectorInstruction || '',
    exampleImageAttachmentIds: rule.exampleImageAttachmentIds || [],
    constraints: joinEnum(rule.constraints),
  }));
}

function materialInitialRandomizationFromRows(rows: MaterialInitialRandomizationRow[]): SubsceneVersion['randomization']['materialInitialState']['rules'] {
  return rows
    .filter((row) => row.targetMaterials.length > 0)
    .map((row) => ({
      targetMaterials: row.targetMaterials,
      changeFrequency: 'every_n_records',
      changeIntervalRecords: row.changeIntervalRecords || 1,
      randomizedFields: {
        locations: row.randomizedFields
          .filter((name) => name.includes('location') || name.includes('位置'))
          .map((name) => ({ name, valueSource: 'object_states.initial.allowed_locations' })),
        poses: row.randomizedFields
          .filter((name) => name.includes('pose') || name.includes('姿态'))
          .map((name) => ({ name, valueSource: 'object_states.initial.allowed_locations.allowed_pose' })),
        forms: row.randomizedFields
          .filter((name) => name.includes('form') || name.includes('形态'))
          .map((name) => ({ name, valueSource: 'object_states.initial.allowed_locations.allowed_form' })),
      },
      collectorInstruction: row.collectorInstruction,
      exampleImageAttachmentIds: row.exampleImageAttachmentIds,
      constraints: splitEnum(row.constraints),
    }));
}

function emptySubsceneVersionDraft(title = '新的任务 SOP'): Partial<SubsceneVersion> {
  return {
    version: '0.0.1',
    status: 'draft',
    title,
    description: '',
    materials: [],
    robotState: { initial: '', target: '' },
    robotOperationRequirements: '',
    robotInitialRandomizationRequirements: [],
    randomizationFrequency: '1',
    randomization: {
      robotInitialState: {
        enabled: true,
        changeFrequency: 'every_n_records',
        changeIntervalRecords: 1,
        randomizedFields: [],
      },
      materialInitialState: { rules: [] },
    },
    operation: {
      stepOrder: '',
      steps: [],
      stepRandomization: { enabled: false, startOrder: 1, endOrder: 1 },
      allowedOperations: [],
      acceptableOperations: [],
      forbiddenOperations: [],
    },
    objectStates: { initial: [], target: [] },
    materialStateRules: [],
    annotation: {
      status: 'pending',
      note: '',
      actionTags: [],
      steps: [],
      allowedOperations: [],
      forbiddenOperations: [],
      stepRandomization: { enabled: false, startOrder: 1, endOrder: 1 },
    },
    references: { recordUrls: [], attachments: [] },
  };
}

function emptyCustomer(): Customer {
  return {
    id: '',
    name: '',
    contact: { name: '', phone: '', email: '' },
    notes: '',
  };
}

function emptyMaterial(skuId = ''): Material {
  return {
    id: '',
    skuId,
    type: '',
    color: '',
    material: '',
    packageType: '',
    images: [],
  };
}

function emptyRobot(): RobotModel {
  return {
    id: '',
    brand: '',
    model: '',
    terminal: '',
    topics: {},
    extraTopicRequirements: {},
  };
}

function emptyScene(name = '新的场景'): Scene {
  return {
    id: '',
    name,
    description: '',
    subscenes: [],
  };
}

function emptyGlobalField(group: GlobalFieldGroup = 'reference_object'): GlobalField {
  return {
    id: '',
    group,
    label: '',
    value: '',
    description: '',
    status: 'active',
    updatedAt: new Date().toISOString(),
  };
}
