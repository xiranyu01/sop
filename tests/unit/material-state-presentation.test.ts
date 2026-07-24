import { describe, expect, it } from 'vitest';
import { materialStateSentence } from '../../shared/domain/materialStatePresentation';

describe('material state presentation', () => {
  it('describes reference relationships in collector-friendly language', () => {
    expect(materialStateSentence({
      object: '漱口杯',
      primaryReference: '水龙头',
      primaryRelativePosition: '侧面',
      secondaryReference: '收纳篮',
      secondaryRelativePosition: '对侧',
    })).toBe('把 漱口杯，放在 水龙头的侧面，更具体位置为 收纳篮的对侧。');
  });

  it('includes only state details that were actually configured', () => {
    expect(materialStateSentence({ object: '牙刷', poses: ['平放'], forms: ['完整'] }))
      .toBe('把 牙刷，姿态为 平放，形态为 完整。');
  });
});
