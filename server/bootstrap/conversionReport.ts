import { stableJson } from '../domain/identity';

export type ConversionIssueCode =
  | 'AMBIGUOUS_REFERENCE'
  | 'COLLISION'
  | 'CORRUPT_GENERATION'
  | 'INVALID_LEGACY_DATA'
  | 'INVALID_CANONICAL_DATA'
  | 'UNRESOLVED_REFERENCE'
  | 'UNCLASSIFIED_FIELD';

export type ConversionIssue = {
  code: ConversionIssueCode;
  owner: string;
  path?: string;
  message: string;
  candidates?: string[];
};

export type ConversionReport = {
  ok: boolean;
  generationId: string;
  sourceFingerprint: string;
  semanticDigest: string;
  cardinalities: Record<string, number>;
  aliases: Record<string, string>;
  recordFingerprints: Record<string, string>;
  explicitlyExcludedLegacyPaths: string[];
  documentedNormalizations: string[];
  issues: ConversionIssue[];
};

export function finalizeConversionReport(report: Omit<ConversionReport, 'ok'>): ConversionReport {
  const issues = [...report.issues].sort((left, right) => {
    const leftJson = stableJson(left);
    const rightJson = stableJson(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
  return { ...report, ok: issues.length === 0, issues };
}
