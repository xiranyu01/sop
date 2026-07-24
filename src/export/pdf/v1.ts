import type { ExportBundleView } from '../../domain/exportBundleView';
import { GlobalFieldGroup, type OperationPolicy, type OperationStep } from '../../../gen/coscene/sop/v1alpha1/common_pb';
import type { FrozenExportContent } from '../../../gen/coscene/sop/export/v1alpha1/bundle_pb';
import { materialStateSentence } from '../../../shared/domain/materialStatePresentation';
import { resolveRandomFieldDisplayName } from '../../../shared/domain/randomFieldPresentation';
import { removeLegacySyntheticMaterialRandomizationConstraints } from '../../../shared/domain/randomization';
import type { PdfAttachment, PdfDocumentModel, PdfSection, PdfTable } from './model';

export const PDF_RENDERER_V1 = 'sop-pdf-v1' as const;

function text(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.length ? value.join('、') : '—';
  return String(value);
}

type TaskEntry = FrozenExportContent['taskSops'][number];
type LocationEntry = NonNullable<NonNullable<TaskEntry['spec']>['objectStates']>['initial'][number]['allowedLocations'][number];

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function hours(value: string | undefined): string {
  if (!value) return '—';
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match) return value;
  const result = Number(match[1] || 0) + Number(match[2] || 0) / 60 + Number(match[3] || 0) / 3600;
  return `${Number(result.toFixed(3))} 小时`;
}

function quantity(value: NonNullable<TaskEntry['spec']>['objects'][number]['quantity']): string {
  if (!value) return '—';
  if (value.amount.case === 'range') {
    return `${value.amount.value.minValue}-${value.amount.value.maxValue} ${value.unit}`.trim();
  }
  return `${value.amount.case === 'fixedValue' ? value.amount.value : 1} ${value.unit}`.trim();
}

function attachments(content: FrozenExportContent, refs: string[]): PdfAttachment[] {
  const wanted = new Set(refs);
  return content.attachments
    .filter((attachment) => wanted.has(attachment.ref))
    .map((attachment) => ({
      name: attachment.filename,
      size: Number(attachment.sizeBytes || 0n),
      contentType: attachment.mediaType,
      url: attachment.publicUri,
    }));
}

function stepsTable(steps: OperationStep[]): PdfTable {
  return {
    columns: ['序号', '中文步骤', '中文原子技能', 'English Step', 'English Atomic Skill'],
    rows: [...steps]
      .sort((left, right) => left.order - right.order)
      .map((step) => [
        String(step.order),
        text(step.description),
        text(step.atomicSkill),
        text(step.englishDescription),
        text(step.englishAtomicSkill),
      ]),
  };
}

function operationItems(policy: OperationPolicy | undefined, kind: 'allowed' | 'acceptable' | 'forbidden'): string[] {
  return (policy?.[kind] ?? []).map((rule) => rule.description).filter(Boolean);
}

function randomFieldName(view: ExportBundleView, field: { fieldId: string; displayName?: string }, material: boolean): string {
  const group = material ? GlobalFieldGroup.MATERIAL_RANDOM_FIELD : GlobalFieldGroup.ROBOT_RANDOM_FIELD;
  return resolveRandomFieldDisplayName(field, material, view.content.globalFields
    .filter((candidate) => candidate.group === group)
    .map((candidate) => ({ label: candidate.label, value: candidate.value, sourceId: candidate.source?.sourceId })));
}

function locationItems(task: TaskEntry, states: Array<{ objectId: string; locations: LocationEntry[] }>): string[] {
  const objects = new Map((task.spec?.objects ?? []).map((object) => [object.id, object.displayName]));
  return states.flatMap((state) => state.locations.map((location) => {
    const primary = location.referencePath.find((item) => item.level === 1);
    const secondary = location.referencePath.find((item) => item.level === 2);
    return [
      materialStateSentence({
        object: objects.get(state.objectId) || '未找到对应物料',
        primaryReference: primary?.referenceObject,
        primaryRelativePosition: primary?.relativePosition,
        supportSurface: location.supportSurface,
        regions: location.regions,
        secondaryReference: secondary?.referenceObject,
        secondaryRelativePosition: secondary?.relativePosition,
        poses: location.poses,
        forms: location.forms,
        parameters: location.parameters.flatMap((item) => item.values),
      }),
      location.collectorInstruction ? `采集员说明：${location.collectorInstruction}` : '',
      location.constraints.length ? `限制条件：${location.constraints.join('、')}` : '',
    ].filter(Boolean).join('\n');
  }));
}

function taskSections(view: ExportBundleView, task = view.taskSop!, prefix = '', idPrefix = ''): PdfSection[] {
  const spec = task.spec;
  const scene = view.content.scenes.find((item) => item.ref === task.sceneRef);
  const heading = (value: string) => prefix ? `${prefix} / ${value}` : value;
  const materials = new Map(view.content.materials.map((item) => [item.ref, item]));
  const objects = new Map((spec?.objects ?? []).map((item) => [item.id, item.displayName]));
  const robotRandomization = spec?.randomization?.robotInitialState;
  const robotConstraints = unique((robotRandomization?.fields ?? []).flatMap((field) => field.constraints));
  const initialStates = spec?.objectStates?.initial ?? [];
  const targetStates = spec?.objectStates?.target ?? [];
  const initialImageRefs = initialStates.flatMap((state) => state.allowedLocations.flatMap((location) => location.exampleAttachmentRefs));
  const targetImageRefs = targetStates.flatMap((state) => state.requiredLocation?.exampleAttachmentRefs ?? []);
  const materialRandomization = spec?.randomization?.objectInitialStates ?? [];
  const materialRandomImageRefs = materialRandomization.flatMap((rule) => rule.exampleAttachmentRefs);
  const materialImageRefs = (spec?.objects ?? []).flatMap((object) => [
    ...object.attachmentRefs,
    ...(object.materialRef ? materials.get(object.materialRef)?.attachmentRefs ?? [] : []),
  ]);
  const materialRows = (spec?.objects ?? []).map((object) => {
    const catalog = object.materialRef ? materials.get(object.materialRef) : undefined;
    const descriptor = object.materialDescriptor;
    return [
      text(descriptor?.sku || catalog?.sku),
      text(object.displayName || catalog?.displayName),
      quantity(object.quantity),
      text(descriptor?.color || catalog?.colors),
      text(descriptor?.composition || catalog?.compositions),
      text(descriptor?.packaging || catalog?.packaging),
      text(catalog?.size),
      text(catalog?.weight),
    ];
  });
  const materialRandomRows = materialRandomization.map((rule) => [
    text(rule.objectIds.map((id) => objects.get(id)).filter((name): name is string => Boolean(name))),
    String(rule.change?.intervalRecords ?? 1),
    text(rule.fields.map((field) => randomFieldName(view, field, true))),
    text(rule.collectorInstruction),
    text(removeLegacySyntheticMaterialRandomizationConstraints(rule.constraints)),
  ]);
  const sections: PdfSection[] = [
    {
      id: `${idPrefix}basic`, heading: heading('基础信息'), rows: [
        { label: '任务 SOP 名称', value: text(task.displayName) },
        { label: '场景', value: text(scene?.displayName) },
        { label: '任务 SOP 描述', value: text(task.description) },
      ],
    },
    { id: `${idPrefix}attachments`, heading: heading('任务 SOP 附件'), attachments: attachments(view.content, task.attachmentRefs) },
    {
      id: `${idPrefix}robot`, heading: heading('机器人与随机性'), rows: [
        { label: '机器人初始态', value: text(spec?.robotState?.initial) },
        { label: '机器人目标态', value: text(spec?.robotState?.target) },
      ],
      tables: robotRandomization?.enabled ? [{
        columns: ['对象', '每多少条变换', '随机性要求', '限制条件'],
        rows: [[
          '机器人初始态',
          String(robotRandomization.change?.intervalRecords ?? 1),
          text(robotRandomization.fields.map((field) => randomFieldName(view, field, false))),
          text(robotConstraints),
        ]],
      }] : [],
    },
    {
      id: `${idPrefix}materials`, heading: heading('已选物料'), tables: [{
        columns: ['SKU', '物料名称', '数量', '颜色', '材质', '包装类型', '尺寸', '重量'],
        rows: materialRows,
      }],
    },
    { id: `${idPrefix}material-images`, heading: heading('物料图片'), attachments: attachments(view.content, unique(materialImageRefs)) },
    {
      id: `${idPrefix}initial-states`, heading: heading('物料初始状态'),
      items: locationItems(task, initialStates.map((state) => ({ objectId: state.objectId, locations: state.allowedLocations }))),
      attachments: attachments(view.content, unique(initialImageRefs)),
    },
    {
      id: `${idPrefix}target-states`, heading: heading('物料目标状态'),
      items: locationItems(task, targetStates.flatMap((state) => state.requiredLocation ? [{ objectId: state.objectId, locations: [state.requiredLocation] }] : [])),
      attachments: attachments(view.content, unique(targetImageRefs)),
    },
    {
      id: `${idPrefix}material-randomization`, heading: heading('物料初始状态随机性'), tables: [{
        columns: ['哪些物料', '每 N 条换一次', '需要变化什么', '给采集员看的说明', '限制条件'],
        rows: materialRandomRows,
      }], attachments: attachments(view.content, unique(materialRandomImageRefs)),
    },
    {
      id: `${idPrefix}collection-steps`, heading: heading('采集步骤'),
      tables: [stepsTable(spec?.collection?.steps ?? [])],
      rows: spec?.collection?.stepRandomization?.enabled ? [{
        label: '采集步骤随机性',
        value: `第 ${spec.collection.stepRandomization.startStepNumber ?? 1} 步到第 ${spec.collection.stepRandomization.endStepNumber ?? 1} 步顺序可随机`,
      }] : [],
    },
    { id: `${idPrefix}collection-allowed`, heading: heading('采集操作要求'), items: operationItems(spec?.collection?.policy, 'allowed') },
    { id: `${idPrefix}collection-forbidden`, heading: heading('采集禁止操作'), items: operationItems(spec?.collection?.policy, 'forbidden') },
    { id: `${idPrefix}collection-acceptable`, heading: heading('不完美但可接受的采集操作'), items: operationItems(spec?.collection?.policy, 'acceptable') },
    { id: `${idPrefix}annotation-steps`, heading: heading('标注步骤'), tables: [stepsTable(spec?.annotation?.steps ?? [])] },
    { id: `${idPrefix}annotation-allowed`, heading: heading('标注操作要求'), items: operationItems(spec?.annotation?.policy, 'allowed') },
    { id: `${idPrefix}annotation-forbidden`, heading: heading('标注禁止操作'), items: operationItems(spec?.annotation?.policy, 'forbidden') },
  ];
  return sections;
}

function requirementSections(view: ExportBundleView): PdfSection[] {
  const requirement = view.requirement!;
  const spec = requirement.spec;
  const customer = view.content.customers.find((item) => item.ref === spec?.customerRef);
  const robot = view.content.robotModelRevisions.find((item) => item.ref === spec?.robotModelRevisionRef);
  const global = spec?.globalRequirements;
  const rootAttachments = attachments(view.content, requirement.attachmentRefs);
  const productionRows = (spec?.productionItems ?? []).map((item) => {
    const task = view.content.taskSops.find((candidate) => candidate.ref === item.taskSopRef);
    return [
      item.displayName,
      text(item.description),
      text(task?.displayName),
      text(task?.revision?.versionLabel || item.legacyVersionLabel),
      '已确认',
      hours(item.target?.duration),
      item.target?.collectionCount === undefined ? '—' : String(item.target.collectionCount),
    ];
  });
  const sections: PdfSection[] = [
    {
      id: 'basic', heading: '基础信息', rows: [
        { label: '需求名称', value: requirement.displayName },
        { label: '项目名称', value: text(spec?.projectDisplayName) },
        { label: '客户', value: text(customer?.displayName) },
        { label: '机器人型号', value: text(robot?.displayName) },
        { label: '截止日期', value: text(spec?.deadline) },
        { label: '总目标时长', value: hours(spec?.aggregateTarget?.duration) },
        { label: '原始需求来源链接', value: text(spec?.sourceUri) },
        { label: '数据用途/业务目标', value: text(spec?.businessGoal) },
      ],
    },
    { id: 'attachments', heading: '客户附件', attachments: rootAttachments },
    {
      id: 'delivery', heading: '交付 / 标注 / 质检', rows: [
        { label: '交付形式', value: text(spec?.delivery?.method) },
        { label: '交付数据', value: text(spec?.delivery?.formats) },
        { label: '交付语言', value: text(spec?.delivery?.languages.map((item) => item.displayName || item.code)) },
        { label: '是否需要标注', value: spec?.annotation?.required === undefined ? '—' : spec.annotation.required ? '需要' : '不需要' },
        { label: '标注类型', value: text(spec?.annotation?.types) },
        { label: '客户抽检策略', value: text(spec?.qualityInspection?.samplingPolicy) },
      ],
    },
    {
      id: 'global', heading: '全局要求', rows: [
        { label: '客户额外 topic 要求', value: text(spec?.extraTopicRequirementsText || global?.topics.map((topic) => `${topic.topicId}：${topic.constraints.join('、')}`)) },
        { label: '全局随机性要求', value: text(global?.randomizationNotes) },
        { label: '其他补充说明', value: text(global?.additionalNotes) },
      ],
    },
    { id: 'global-collection-allowed', heading: '采集操作要求', items: operationItems(global?.collectionPolicy, 'allowed') },
    { id: 'global-collection-acceptable', heading: '不完美但可接受的采集操作', items: operationItems(global?.collectionPolicy, 'acceptable') },
    { id: 'global-collection-forbidden', heading: '采集禁止操作', items: operationItems(global?.collectionPolicy, 'forbidden') },
    { id: 'global-annotation-allowed', heading: '标注操作要求', items: operationItems(global?.annotationPolicy, 'allowed') },
    { id: 'global-annotation-forbidden', heading: '标注禁止操作', items: operationItems(global?.annotationPolicy, 'forbidden') },
    {
      id: 'production-items', heading: '生产需求项', tables: [{
        columns: ['生产需求项', '描述', '任务 SOP', '版本', '状态', '目标采集时长', '目标采集数量'],
        rows: productionRows,
      }],
    },
  ];
  for (const [index, item] of (spec?.productionItems ?? []).entries()) {
    const task = view.content.taskSops.find((candidate) => candidate.ref === item.taskSopRef);
    if (task) sections.push(...taskSections(view, task, `任务 SOP ${index + 1}：${task.displayName}`, `task-${index + 1}-`));
  }
  return sections;
}

export function renderPdfModelV1(view: ExportBundleView): PdfDocumentModel {
  return {
    rendererVersion: PDF_RENDERER_V1,
    page: { size: 'A4', marginMm: { top: 15, right: 15, bottom: 15, left: 15 } },
    title: view.title,
    subtitle: `${view.rootKind === 'task_sop' ? '任务 SOP' : '客户需求'} · v${view.versionLabel}`,
    fileName: `${view.title}-v${view.versionLabel}.pdf`,
    trace: [],
    sections: view.rootKind === 'task_sop' ? taskSections(view) : requirementSections(view),
  };
}
