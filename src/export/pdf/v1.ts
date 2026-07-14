import type { ExportBundleView } from '../../domain/exportBundleView';
import type { PdfDocumentModel, PdfRow, PdfSection } from './model';

export const PDF_RENDERER_V1 = 'sop-pdf-v1' as const;

function text(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.length ? value.join('、') : '—';
  return String(value);
}

function taskSections(view: ExportBundleView): PdfSection[] {
  const task = view.taskSop!;
  const spec = task.spec;
  const scene = view.content.scenes.find((item) => item.ref === task.sceneRef);
  const rows: PdfRow[] = [
    { label: '场景', value: text(scene?.displayName) },
    { label: '预计时长', value: text(spec?.expectedDuration) },
    { label: '机器人操作要求', value: text(spec?.robotOperationRequirements) },
  ];
  return [
    { id: 'overview', heading: '任务概览', rows },
    {
      id: 'objects', heading: '任务物料',
      items: (spec?.objects ?? []).map((item) => `${item.displayName}（${item.id}）`),
    },
    {
      id: 'steps', heading: '采集步骤',
      items: (spec?.collection?.steps ?? [])
        .toSorted((left, right) => left.order - right.order)
        .map((item) => `${item.order}. ${item.description}`),
    },
    { id: 'attachments', heading: '附件', items: view.attachmentNames },
  ];
}

function requirementSections(view: ExportBundleView): PdfSection[] {
  const requirement = view.requirement!;
  const spec = requirement.spec;
  const customer = view.content.customers.find((item) => item.ref === spec?.customerRef);
  const robot = view.content.robotModelRevisions.find((item) => item.ref === spec?.robotModelRevisionRef);
  return [
    {
      id: 'overview', heading: '需求概览', rows: [
        { label: '客户', value: text(customer?.displayName) },
        { label: '机器人型号', value: text(robot?.displayName) },
        { label: '业务目标', value: text(spec?.businessGoal) },
        { label: '优先级', value: text(spec?.priority) },
        { label: '截止日期', value: text(spec?.deadline) },
      ],
    },
    {
      id: 'production-items', heading: '生产项',
      items: (spec?.productionItems ?? []).map((item) => {
        const count = item.target?.collectionCount;
        const target = count !== undefined ? `${count.toString()} 条` : text(item.target?.duration);
        return `${item.displayName}：${target}`;
      }),
    },
    {
      id: 'delivery', heading: '交付要求', rows: [
        { label: '格式', value: text(spec?.delivery?.formats) },
        { label: '方式', value: text(spec?.delivery?.method) },
        { label: '语言', value: text(spec?.delivery?.languages.map((item) => item.displayName || item.code)) },
      ],
    },
    { id: 'attachments', heading: '附件', items: view.attachmentNames },
  ];
}

export function renderPdfModelV1(view: ExportBundleView): PdfDocumentModel {
  return {
    rendererVersion: PDF_RENDERER_V1,
    page: { size: 'A4', marginMm: { top: 15, right: 15, bottom: 15, left: 15 } },
    title: view.title,
    subtitle: `${view.rootKind === 'task_sop' ? '任务 SOP' : '客户需求'} · ${view.versionLabel}`,
    trace: [
      { label: '资源名', value: view.rootName },
      { label: '资源 UID', value: view.rootUid },
      { label: '版本名', value: view.revisionName },
      { label: '版本 UID', value: view.revisionUid },
      { label: '确认时间', value: view.confirmationTime },
    ],
    sections: view.rootKind === 'task_sop' ? taskSections(view) : requirementSections(view),
  };
}

