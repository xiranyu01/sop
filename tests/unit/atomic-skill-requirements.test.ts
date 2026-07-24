import { describe, expect, it } from 'vitest';
import { appendMissingAtomicSkillRequirements, atomicSkillRequirement } from '../../src/domain/atomicSkillRequirements';
import type { GlobalField, OperationStep, TextItem } from '../../src/domain/viewModels';

function field(
  label: string,
  patch: Partial<GlobalField> = {},
): GlobalField {
  return {
    id: `field-${label}`,
    group: 'atomic_skill',
    label,
    value: label,
    startCondition: '夹爪开始闭合',
    endCondition: '物体稳定离开支撑面',
    status: 'active',
    updatedAt: '2026-07-22T00:00:00.000Z',
    ...patch,
  };
}

function step(order: number, atomicSkill?: string): OperationStep {
  return { order, description: `步骤 ${order}`, atomicSkill };
}

describe('atomic skill annotation requirements', () => {
  it('formats one global boundary using the fixed Chinese sentence', () => {
    expect(atomicSkillRequirement(field('拿起'))).toBe(
      '拿起：开始时机为夹爪开始闭合；结束时机为物体稳定离开支撑面',
    );
  });

  it('adds one ordinary requirement for each distinct skill missing from the requirements', () => {
    const result = appendMissingAtomicSkillRequirements(
      [step(1, '拿起'), step(2, '拿起'), step(3, '放置')],
      [{ description: '已有要求' }],
      [field('拿起'), field('放置', { startCondition: '夹爪开始张开', endCondition: '物体稳定接触目标位置' })],
    );

    expect(result).toEqual([
      { description: '已有要求' },
      { description: '拿起：开始时机为夹爪开始闭合；结束时机为物体稳定离开支撑面' },
      { description: '放置：开始时机为夹爪开始张开；结束时机为物体稳定接触目标位置' },
    ]);
  });

  it('does not duplicate an existing sentence or overwrite a manually edited snapshot', () => {
    const generated: TextItem[] = [{
      description: '拿起：开始时机为人工修改；结束时机为人工确认',
    }];
    expect(appendMissingAtomicSkillRequirements(
      [step(1, '拿起'), step(2, '拿起')],
      generated,
      [field('拿起', { startCondition: '全局后来修改' })],
    )).toBe(generated);

    const exact = [{ description: atomicSkillRequirement(field('放置'))! }];
    expect(appendMissingAtomicSkillRequirements([step(1, '放置')], exact, [field('放置')])).toBe(exact);
  });

  it('backfills a requirement when an existing SOP already used the skill before this edit', () => {
    expect(appendMissingAtomicSkillRequirements(
      [step(1, '拿起'), step(2, '拿起')],
      [{ description: '需要连续标注' }],
      [field('拿起')],
    )).toEqual([
      { description: '需要连续标注' },
      { description: '拿起：开始时机为夹爪开始闭合；结束时机为物体稳定离开支撑面' },
    ]);
  });

  it('ignores unmatched, inactive, and incomplete definitions', () => {
    const requirements: TextItem[] = [];
    expect(appendMissingAtomicSkillRequirements(
      [step(1, '未知'), step(2, '停用'), step(3, '不完整')],
      requirements,
      [
        field('停用', { status: 'inactive' }),
        field('不完整', { endCondition: undefined }),
      ],
    )).toBe(requirements);
  });
});
