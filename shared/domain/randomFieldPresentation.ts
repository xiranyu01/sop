type RandomFieldDefinition = {
  material: boolean;
  label: string;
  labels: string[];
  tokens: string[];
};

const definitions: RandomFieldDefinition[] = [
  { material: false, label: '位置', labels: ['位置', '机器位置'], tokens: ['initial-position', 'initial_position'] },
  { material: false, label: '机器朝向', labels: ['朝向', '机器朝向'], tokens: ['initial-yaw', 'initial_yaw'] },
  { material: true, label: '物料位置', labels: ['物料位置'], tokens: ['location'] },
  { material: true, label: '物料姿态', labels: ['物料姿态'], tokens: ['pose'] },
  { material: true, label: '物料形态', labels: ['物料形态'], tokens: ['form'] },
];

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function semanticTokens(value: string): string[] {
  const token = normalized(value);
  if (!token) return [];
  const withoutHash = token.replace(/-[a-f0-9]{8,}$/i, '');
  const withoutPrefix = withoutHash.replace(/^(?:gf-)?random-field-/, '');
  return Array.from(new Set([token, withoutHash, withoutPrefix])).filter(Boolean);
}

export function randomFieldAliasesForLabel(label: string): string[] {
  return definitions.find((definition) => definition.labels.includes(label))?.tokens ?? [];
}

export function randomFieldFallbackLabel(value: string, material: boolean): string | undefined {
  const values = new Set(semanticTokens(value));
  return definitions.find((definition) =>
    definition.material === material && definition.tokens.some((token) => values.has(normalized(token))))?.label;
}

export type RandomFieldDisplayOption = {
  label: string;
  value: string;
  sourceId?: string;
};

export function resolveRandomFieldDisplayName(
  field: { fieldId: string; displayName?: string },
  material: boolean,
  options: RandomFieldDisplayOption[] = [],
): string {
  const value = field.displayName || field.fieldId;
  const storedValues = new Set([field.fieldId, value]);
  const direct = options.find((option) =>
    [option.value, option.label, option.sourceId].some((candidate) => candidate && storedValues.has(candidate)));
  if (direct) return direct.label;

  const fallback = randomFieldFallbackLabel(field.fieldId, material)
    || randomFieldFallbackLabel(value, material);
  const semantic = fallback && options.find((option) =>
    [option.sourceId, option.value, option.label].some((candidate) =>
      candidate && randomFieldFallbackLabel(candidate, material) === fallback));
  if (semantic) return semantic.label;
  if (fallback) return fallback;
  if (/^[a-z0-9][a-z0-9_-]*$/i.test(value)) {
    throw new TypeError(`随机字段缺少可展示的中文名称：${value}`);
  }
  return value;
}
