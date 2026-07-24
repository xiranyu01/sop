import { describe, expect, it } from 'vitest';
import type { GlobalFieldGroup } from '../../src/domain/viewModels';
import { globalFieldsFromCsv, globalFieldsToCsv } from '../../src/domain/globalFieldCsv';

const labels = {
  region: '区域',
  delivery_language: '交付语言',
  atomic_skill: '原子技能说明',
} as Record<GlobalFieldGroup, string>;

describe('global field CSV', () => {
  it('round-trips Chinese text, commas, quotes, and line breaks', () => {
    const csv = globalFieldsToCsv([{
      id: 'field-back',
      group: 'region',
      label: '后侧',
      value: '后侧',
      startCondition: undefined,
      endCondition: undefined,
      description: '包含逗号, 引号"和\n换行',
      status: 'active',
      updatedAt: '2026-07-21T00:00:00.000Z',
    }], labels);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(globalFieldsFromCsv(csv, labels, '2026-07-21T01:00:00.000Z')).toEqual([{
      id: 'field-back',
      group: 'region',
      label: '后侧',
      value: '后侧',
      description: '包含逗号, 引号"和\n换行',
      status: 'active',
      updatedAt: '2026-07-21T01:00:00.000Z',
    }]);
  });

  it('round-trips atomic skill boundary conditions', () => {
    const field = {
      id: 'field-pickup',
      group: 'atomic_skill' as const,
      label: '拿起',
      value: '拿起',
      startCondition: '夹爪开始闭合',
      endCondition: '物体稳定离开支撑面',
      status: 'active' as const,
      updatedAt: '2026-07-21T00:00:00.000Z',
    };
    const csv = globalFieldsToCsv([field], labels);

    expect(csv).toContain('开始时机');
    expect(globalFieldsFromCsv(csv, labels, field.updatedAt)).toEqual([{ ...field, description: undefined }]);
    expect(() => globalFieldsFromCsv(
      '字段ID,字段分组,字段名称,开始时机,结束时机,说明,状态\n,原子技能说明,拿起,夹爪开始闭合,,,启用',
      labels,
    )).toThrow('必须填写“开始时机”和“结束时机”');
  });

  it('accepts group codes and rejects duplicate rows before replacement', () => {
    expect(globalFieldsFromCsv(
      '字段ID,字段分组,字段名称,说明,状态\n,delivery_language,英语,,inactive',
      labels,
    )[0]).toMatchObject({ id: '', group: 'delivery_language', status: 'inactive' });
    expect(() => globalFieldsFromCsv(
      '字段ID,字段分组,字段名称,说明,状态\na,区域,后侧,,启用\nb,区域,后侧,,启用',
      labels,
    )).toThrow('分组内字段名称重复');
  });

  it('rejects missing columns and an empty replacement', () => {
    expect(() => globalFieldsFromCsv('字段ID,字段名称\na,后侧', labels)).toThrow('CSV 缺少列');
    expect(() => globalFieldsFromCsv('字段ID,字段分组,字段名称,说明,状态\n', labels)).toThrow('至少需要一条');
  });

  it('keeps accepting the previous CSV columns for non-atomic fields', () => {
    expect(globalFieldsFromCsv(
      '字段ID,字段分组,字段名称,说明,状态\nlegacy,区域,后侧,旧版文件,启用',
      labels,
    )[0]).toMatchObject({ id: 'legacy', group: 'region', label: '后侧' });
  });
});
