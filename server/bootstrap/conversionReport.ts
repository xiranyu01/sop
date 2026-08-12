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

// A per-record observation that is not a defect: the legacy export simply had
// nothing to say about a field the canonical schema knows about. Notes never
// affect `ok` — an issue fails the bootstrap, a note only makes the gap visible.
export type ConversionNote = {
  owner: string;
  path?: string;
  message: string;
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
  notes: ConversionNote[];
  issues: ConversionIssue[];
};

export function finalizeConversionReport(report: Omit<ConversionReport, 'ok'>): ConversionReport {
  const byStableJson = <T>(left: T, right: T) => {
    const leftJson = stableJson(left);
    const rightJson = stableJson(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  };
  const issues = [...report.issues].sort(byStableJson);
  const notes = [...report.notes].sort(byStableJson);
  return { ...report, ok: issues.length === 0, issues, notes };
}
