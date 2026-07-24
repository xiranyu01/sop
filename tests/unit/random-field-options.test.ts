import { describe, expect, it } from 'vitest';
import { randomFieldLabel, withStoredRandomFieldOptions } from '../../src/domain/randomFieldOptions';

const options = [
  { value: '位置', label: '位置', aliases: ['gf-random-field-initial-position'] },
  { value: '机器朝向', label: '机器朝向', aliases: ['gf-random-field-initial-yaw'] },
  { value: '物料位置', label: '物料位置', aliases: ['gf-random-field-location'] },
  { value: '物料姿态', label: '物料姿态', aliases: ['gf-random-field-pose'] },
  { value: '物料形态', label: '物料形态', aliases: ['gf-random-field-form'] },
];

describe('random field option display', () => {
  it('maps historical robot field IDs to configured Chinese labels', () => {
    expect(randomFieldLabel('initial-position-8ceebaf4', options)).toBe('位置');
    expect(randomFieldLabel('initial-yaw-6150eb28', options)).toBe('机器朝向');
  });

  it('maps historical material machine values to configured Chinese labels', () => {
    expect(randomFieldLabel('location', options)).toBe('物料位置');
    expect(randomFieldLabel('pose', options)).toBe('物料姿态');
    expect(randomFieldLabel('form', options)).toBe('物料形态');
  });

  it('uses the configured business label when field IDs are opaque', () => {
    const opaqueOptions = [
      { value: '物料位置', label: '物料位置', aliases: ['50a8756c-71dd-4e14-a16c-9d482637c52a'] },
      { value: '位置', label: '位置', aliases: ['23183593-c85e-481f-b7b3-c591ea64f259'] },
    ];

    expect(randomFieldLabel('location', opaqueOptions)).toBe('物料位置');
    expect(randomFieldLabel('initial-position-8ceebaf4', opaqueOptions)).toBe('位置');
  });

  it('keeps the stored value while adding its translated display option', () => {
    const translated = withStoredRandomFieldOptions(options, [
      { value: 'initial-position-8ceebaf4' },
      { value: 'location' },
      { value: 'location' },
    ]);

    expect(translated).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'initial-position-8ceebaf4', label: '位置' }),
      expect.objectContaining({ value: 'location', label: '物料位置' }),
    ]));
    expect(translated.filter((option) => option.label === '位置')).toHaveLength(1);
    expect(translated.filter((option) => option.label === '物料位置')).toHaveLength(1);
    expect(translated.filter((option) => option.value === 'location')).toHaveLength(1);
  });

  it('leaves unknown historical values readable and unchanged', () => {
    expect(randomFieldLabel('legacy-unknown-field', options)).toBe('legacy-unknown-field');
  });
});
