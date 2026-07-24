import { describe, expect, it } from 'vitest';
import {
  deliveryLanguageSelectionValue,
  normalizeDeliveryLanguage,
  parseDeliveryLanguageSelection,
} from '../../src/domain/deliveryLanguage';

describe('delivery language selection mapping', () => {
  it('maps configured language labels to stable language codes', () => {
    expect(parseDeliveryLanguageSelection('英文')).toEqual({ code: 'en', name: '英文' });
    expect(parseDeliveryLanguageSelection('简体中文')).toEqual({ code: 'zh-CN', name: '简体中文' });
  });

  it('repairs the legacy duplicated code and name without changing the label', () => {
    const repaired = normalizeDeliveryLanguage({ code: '英文', name: '英文' });
    expect(repaired).toEqual({ code: 'en', name: '英文' });
    expect(deliveryLanguageSelectionValue(repaired)).toBe('en:英文');
    expect(parseDeliveryLanguageSelection('英文:英文')).toEqual(repaired);
  });

  it('preserves already structured values', () => {
    expect(parseDeliveryLanguageSelection('zh-CN:简体中文')).toEqual({ code: 'zh-CN', name: '简体中文' });
    expect(deliveryLanguageSelectionValue({ code: 'en', name: '英文' })).toBe('en:英文');
  });
});
