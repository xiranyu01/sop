export type DeliveryLanguage = { code: string; name: string };

const languageCodeByName: Readonly<Record<string, string>> = {
  '简体中文': 'zh-CN',
  '中文': 'zh-CN',
  '英文': 'en',
  '英语': 'en',
  '原始文本': 'zh-CN',
  '源语言': 'zh-CN',
};

const canonicalLanguageCode: Readonly<Record<string, string>> = {
  'zh-CN': 'zh-CN',
  en: 'en',
  source: 'zh-CN',
};

export const canonicalDeliveryLanguageNames: Readonly<Record<string, string>> = {
  'zh-CN': '简体中文',
  en: '英文',
};

export function normalizeDeliveryLanguage(language: DeliveryLanguage): DeliveryLanguage {
  const name = language.name.trim() || language.code.trim();
  const rawCode = language.code.trim();
  const inferredCode = rawCode === name && languageCodeByName[name]
    ? languageCodeByName[name]
    : languageCodeByName[name] || rawCode || name;
  const code = canonicalLanguageCode[inferredCode] || inferredCode;
  return { code, name };
}

export function canonicalDeliveryLanguageName(code: string): string | undefined {
  return canonicalDeliveryLanguageNames[normalizeDeliveryLanguage({ code, name: code }).code];
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
