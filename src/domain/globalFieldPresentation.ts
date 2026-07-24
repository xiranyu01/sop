import type { GlobalField } from './viewModels';

const pinyinCollator = new Intl.Collator('zh-CN-u-co-pinyin', {
  usage: 'sort',
  sensitivity: 'base',
  numeric: true,
});

export function sortGlobalFieldsByPinyin<T extends Pick<GlobalField, 'id' | 'label'>>(fields: T[]): T[] {
  return [...fields].sort((left, right) =>
    pinyinCollator.compare(left.label.trim(), right.label.trim())
    || left.id.localeCompare(right.id));
}
