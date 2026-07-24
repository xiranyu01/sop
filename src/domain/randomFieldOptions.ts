import { randomFieldAliasesForLabel } from '../../shared/domain/randomFieldPresentation';

export type RandomFieldOption = {
  value: string;
  label: string;
  aliases?: string[];
};

function normalizedToken(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function semanticTokens(value: string): string[] {
  const normalized = normalizedToken(value);
  if (!normalized) return [];

  const withoutGeneratedHash = normalized.replace(/-[a-f0-9]{8,}$/i, '');
  const withoutGlobalFieldPrefix = withoutGeneratedHash.replace(/^(?:gf-)?random-field-/, '');
  return Array.from(new Set([normalized, withoutGeneratedHash, withoutGlobalFieldPrefix])).filter(Boolean);
}

function matchesStoredValue(option: RandomFieldOption, storedValue: string, aliases: string[]): boolean {
  const storedCandidates = [storedValue, ...aliases].filter(Boolean);
  const optionCandidates = [
    option.value,
    option.label,
    ...(option.aliases ?? []),
    ...randomFieldAliasesForLabel(option.label),
  ].filter(Boolean);
  if (storedCandidates.some((candidate) => optionCandidates.includes(candidate))) return true;

  const storedTokens = new Set(storedCandidates.flatMap(semanticTokens));
  return optionCandidates
    .flatMap(semanticTokens)
    .some((token) => storedTokens.has(token));
}

export function randomFieldLabel(
  storedValue: string,
  options: RandomFieldOption[],
  aliases: string[] = [],
): string {
  return options.find((option) => matchesStoredValue(option, storedValue, aliases))?.label
    || aliases.find(Boolean)
    || storedValue;
}

/** Adds translated display options without rewriting historical stored IDs. */
export function withStoredRandomFieldOptions(
  options: RandomFieldOption[],
  storedFields: Array<{ value: string; aliases?: string[] }>,
): RandomFieldOption[] {
  const seen = new Set(options.map((option) => option.value));
  const additions = storedFields
    .filter(({ value }) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .map(({ value, aliases = [] }) => ({
      value,
      label: randomFieldLabel(value, options, aliases),
      aliases,
    }));
  const selectedLabels = new Set(additions.map((option) => option.label));
  const combined = [
    ...options.filter((option) => !selectedLabels.has(option.label)),
    ...additions,
  ];
  const seenLabels = new Set<string>();
  return combined.filter((option) => {
    if (seenLabels.has(option.label)) return false;
    seenLabels.add(option.label);
    return true;
  });
}
