import Papa from 'papaparse';
import type { GlobalField, GlobalFieldGroup, GlobalFieldStatus } from './viewModels';

const requiredHeaders = ['字段ID', '字段分组', '字段名称', '说明', '状态'] as const;
const headers = ['字段ID', '字段分组', '字段名称', '开始时机', '结束时机', '说明', '状态'] as const;

type CsvRow = Record<(typeof headers)[number], string>;

function normalizedStatus(value: string, rowNumber: number): GlobalFieldStatus {
  const normalized = value.trim().toLowerCase();
  if (normalized === '启用' || normalized === 'active') return 'active';
  if (normalized === '停用' || normalized === 'inactive') return 'inactive';
  throw new Error(`第 ${rowNumber} 行“状态”必须是“启用”或“停用”`);
}

function groupByCsvValue(
  value: string,
  labels: Record<GlobalFieldGroup, string>,
  rowNumber: number,
): GlobalFieldGroup {
  const normalized = value.trim();
  const byCode = (Object.keys(labels) as GlobalFieldGroup[]).find((group) => group === normalized);
  const byLabel = (Object.entries(labels) as Array<[GlobalFieldGroup, string]>).find(([, label]) => label === normalized)?.[0];
  const group = byCode || byLabel;
  if (!group) throw new Error(`第 ${rowNumber} 行“字段分组”无法识别：${normalized || '空值'}`);
  return group;
}

export function globalFieldsToCsv(
  fields: GlobalField[],
  labels: Record<GlobalFieldGroup, string>,
): string {
  const rows: CsvRow[] = [...fields]
    .sort((left, right) => left.group.localeCompare(right.group, 'en') || left.label.localeCompare(right.label, 'zh-CN'))
    .map((field) => ({
      字段ID: field.id,
      字段分组: labels[field.group],
      字段名称: field.label,
      开始时机: field.startCondition || '',
      结束时机: field.endCondition || '',
      说明: field.description || '',
      状态: field.status === 'active' ? '启用' : '停用',
    }));
  return `\uFEFF${Papa.unparse(rows, { columns: [...headers], newline: '\r\n', escapeFormulae: true })}`;
}

export function globalFieldsFromCsv(
  source: string,
  labels: Record<GlobalFieldGroup, string>,
  updatedAt = new Date().toISOString(),
): GlobalField[] {
  const parsed = Papa.parse<CsvRow>(source.replace(/^\uFEFF/u, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (value) => value.trim(),
  });
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(`CSV 解析失败${first.row === undefined ? '' : `（第 ${first.row + 2} 行）`}：${first.message}`);
  }
  const actualHeaders = parsed.meta.fields ?? [];
  const missingHeaders = requiredHeaders.filter((header) => !actualHeaders.includes(header));
  if (missingHeaders.length > 0) throw new Error(`CSV 缺少列：${missingHeaders.join('、')}`);
  if (parsed.data.length === 0) throw new Error('CSV 中至少需要一条全局字段');

  const ids = new Set<string>();
  const groupLabels = new Set<string>();
  return parsed.data.map((row, index) => {
    const rowNumber = index + 2;
    const id = row.字段ID.trim();
    const group = groupByCsvValue(row.字段分组, labels, rowNumber);
    const label = row.字段名称.trim();
    const startCondition = (row.开始时机 ?? '').trim();
    const endCondition = (row.结束时机 ?? '').trim();
    if (!label) throw new Error(`第 ${rowNumber} 行“字段名称”不能为空`);
    if (group === 'atomic_skill' && (!startCondition || !endCondition)) {
      throw new Error(`第 ${rowNumber} 行原子技能必须填写“开始时机”和“结束时机”`);
    }
    if (id && ids.has(id)) throw new Error(`第 ${rowNumber} 行“字段ID”重复：${id}`);
    const groupLabelKey = `${group}\u0000${label}`;
    if (groupLabels.has(groupLabelKey)) throw new Error(`第 ${rowNumber} 行分组内字段名称重复：${label}`);
    if (id) ids.add(id);
    groupLabels.add(groupLabelKey);
    return {
      id,
      group,
      label,
      value: label,
      startCondition: startCondition || undefined,
      endCondition: endCondition || undefined,
      description: row.说明.trim() || undefined,
      status: normalizedStatus(row.状态, rowNumber),
      updatedAt,
    };
  });
}
