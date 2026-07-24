export type DeliveryLanguage = { code: string; name: string };

const languageCodeByName: Readonly<Record<string, string>> = {
  '简体中文': 'zh-CN',
  '中文': 'zh-CN',
  '英文': 'en',
  '英语': 'en',
};

export function normalizeDeliveryLanguage(language: DeliveryLanguage): DeliveryLanguage {
  const name = language.name.trim() || language.code.trim();
  const rawCode = language.code.trim();
  const code = rawCode === name && languageCodeByName[name]
    ? languageCodeByName[name]
    : languageCodeByName[name] || rawCode || name;
  return { code, name };
}

export function parseDeliveryLanguageSelection(value: string): DeliveryLanguage {
  const separator = value.indexOf(':');
  if (separator < 0) return normalizeDeliveryLanguage({ code: value, name: value });
  return normalizeDeliveryLanguage({
    code: value.slice(0, separator),
    name: value.slice(separator + 1),
  });
}

export function deliveryLanguageSelectionValue(language: DeliveryLanguage): string {
  const normalized = normalizeDeliveryLanguage(language);
  return normalized.code === normalized.name ? normalized.name : `${normalized.code}:${normalized.name}`;
}
