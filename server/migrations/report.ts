import { stableJson } from './identity';

export type MigrationIssueCode =
  | 'AMBIGUOUS_REFERENCE'
  | 'COLLISION'
  | 'CORRUPT_GENERATION'
  | 'INVALID_LEGACY_DATA'
  | 'INVALID_CANONICAL_DATA'
  | 'UNRESOLVED_REFERENCE'
  | 'UNCLASSIFIED_FIELD';

export type MigrationIssue = {
  code: MigrationIssueCode;
  owner: string;
  path?: string;
  message: string;
  candidates?: string[];
};

export type MigrationReport = {
  ok: boolean;
  generationId: string;
  sourceFingerprint: string;
  semanticDigest: string;
  cardinalities: Record<string, number>;
  aliases: Record<string, string>;
  recordFingerprints: Record<string, string>;
  explicitlyExcludedLegacyPaths: string[];
  documentedNormalizations: string[];
  issues: MigrationIssue[];
};

export function finalizeReport(report: Omit<MigrationReport, 'ok'>): MigrationReport {
  const issues = [...report.issues].sort((left, right) => stableJson(left) < stableJson(right) ? -1 : stableJson(left) > stableJson(right) ? 1 : 0);
  return { ...report, ok: issues.length === 0, issues };
}
