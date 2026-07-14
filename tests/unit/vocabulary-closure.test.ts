import { describe, expect, it } from 'vitest';
import { convertLegacyToV1alpha1 } from '../../server/bootstrap/legacyToV1alpha1';
import { seedData } from '../e2e/fixtures/seed';

describe('frozen vocabulary closure', () => {
  it('selects values only from their structural group and ignores unrelated text collisions', () => {
    const data = structuredClone(seedData);
    data.scenes[0].subscenes[0].versions[0].description = 'ordinary-collision';
    data.globalFields.push(
      {
        id: 'field-other-group', group: 'allowed_operation', label: '普通文本', value: '安全初始位',
        status: 'active', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'field-description-collision', group: 'parameter', label: '描述碰撞', value: 'ordinary-collision',
        status: 'active', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'field-format', group: 'delivery_format', label: 'JSON', value: 'json',
        status: 'active', updatedAt: '2026-01-01T00:00:00.000Z',
      },
    );
    data.requirements[0].versions[0].delivery.formats = ['json'];

    const result = convertLegacyToV1alpha1(data);

    expect(result.report.ok).toBe(true);
    expect(result.resources.taskSopRevisions[0].frozenDependencies!.globalFields.map((field) => field.sourceId))
      .toEqual(['field-baseline']);
    expect(result.resources.requirementRevisions[0].frozenDependencies!.globalFields.map((field) => field.sourceId))
      .toContain('field-format');
  });

  it('fails closed when one group/value reference is ambiguous', () => {
    const data = structuredClone(seedData);
    data.globalFields.push({
      id: 'field-baseline-duplicate', group: 'robot_state', label: '重复安全初始位', value: '安全初始位',
      status: 'active', updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = convertLegacyToV1alpha1(data);

    expect(result.report.ok).toBe(false);
    expect(result.report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AMBIGUOUS_REFERENCE',
        message: expect.stringContaining('robot_state'),
        candidates: expect.arrayContaining(['globalFields/field-baseline', 'globalFields/field-baseline-duplicate']),
      }),
    ]));
  });
});
