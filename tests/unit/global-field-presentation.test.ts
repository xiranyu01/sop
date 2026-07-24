import { describe, expect, it } from 'vitest';
import { sortGlobalFieldsByPinyin } from '../../src/domain/globalFieldPresentation';

describe('global field presentation', () => {
  it('sorts field names by Chinese pinyin and keeps the input unchanged', () => {
    const fields = [
      { id: 'z', label: '左侧' },
      { id: 'q', label: '前侧' },
      { id: 'a', label: '安全位' },
      { id: 'h', label: '后侧' },
      { id: 'b', label: '表面' },
      { id: 'c', label: '侧面' },
    ];

    expect(sortGlobalFieldsByPinyin(fields).map((field) => field.label))
      .toEqual(['安全位', '表面', '侧面', '后侧', '前侧', '左侧']);
    expect(fields.map((field) => field.label))
      .toEqual(['左侧', '前侧', '安全位', '后侧', '表面', '侧面']);
  });

  it('uses the field ID as a stable tie breaker for duplicate names', () => {
    expect(sortGlobalFieldsByPinyin([
      { id: 'field-b', label: '位置' },
      { id: 'field-a', label: '位置' },
    ]).map((field) => field.id)).toEqual(['field-a', 'field-b']);
  });
});
